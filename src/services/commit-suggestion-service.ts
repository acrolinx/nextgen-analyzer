/**
 * Commit Suggestion service for creating GitHub commit suggestions
 */

import * as core from '@actions/core'
import * as github from '@actions/github'
import { diffLines } from 'diff'
import {
  AcrolinxAnalysisResult,
  CommitSuggestion,
  PRSuggestionData
} from '../types/index.js'
import { readFileContent } from '../utils/file-utils.js'
import { handleGitHubError, logError } from '../utils/error-utils.js'

/**
 * Generate diff between original and rewritten content
 */
function generateDiff(
  originalContent: string,
  rewrittenContent: string
): string {
  const diffs = diffLines(originalContent, rewrittenContent, {
    ignoreWhitespace: false,
    ignoreNewlineAtEof: false
  })

  return diffs
    .map((part) => {
      if (part.added) {
        return `+${part.value}`
      } else if (part.removed) {
        return `-${part.value}`
      } else {
        return part.value
      }
    })
    .join('')
}

/**
 * Convert diff to file-level suggestion (entire rewritten content)
 */
function createFileSuggestion(
  originalContent: string,
  rewrittenContent: string
): string {
  // Return the entire rewritten content as the suggestion
  return rewrittenContent
}

/**
 * Find the line number where the suggestion should be applied
 */
function findSuggestionLineNumber(
  originalContent: string,
  rewrittenContent: string
): number {
  const originalLines = originalContent.split('\n')
  const rewrittenLines = rewrittenContent.split('\n')

  // Find the first line that differs
  for (
    let i = 0;
    i < Math.min(originalLines.length, rewrittenLines.length);
    i++
  ) {
    if (originalLines[i] !== rewrittenLines[i]) {
      return i + 1 // GitHub uses 1-based line numbers
    }
  }

  // If no difference found in existing lines, return the first line
  return 1
}

/**
 * Create commit suggestions from Acrolinx analysis results
 */
export async function createCommitSuggestions(
  results: AcrolinxAnalysisResult[]
): Promise<CommitSuggestion[]> {
  const suggestions: CommitSuggestion[] = []

  for (const result of results) {
    try {
      // Read the original file content
      const originalContent = await readFileContent(result.filePath)

      if (!originalContent) {
        core.warning(`Could not read original content for ${result.filePath}`)
        continue
      }

      // Skip if rewrite is empty or same as original
      if (!result.rewrite || result.rewrite.trim() === originalContent.trim()) {
        continue
      }

      // Generate diff
      const diff = generateDiff(originalContent, result.rewrite)

      if (!diff.trim()) {
        continue
      }

      // Create file-level suggestion
      const suggestion = createFileSuggestion(originalContent, result.rewrite)

      if (!suggestion.trim()) {
        continue
      }

      // Find line number for suggestion
      const lineNumber = findSuggestionLineNumber(
        originalContent,
        result.rewrite
      )

      core.info(
        `Processing suggestion for ${result.filePath}: line ${lineNumber}, suggestion length: ${suggestion.length}`
      )

      suggestions.push({
        filePath: result.filePath,
        originalContent,
        rewrittenContent: result.rewrite,
        diff,
        lineNumber,
        suggestion
      })

      core.info(
        `✅ Generated suggestion for ${result.filePath} at line ${lineNumber}`
      )
    } catch (error) {
      core.warning(
        `Failed to create suggestion for ${result.filePath}: ${error}`
      )
    }
  }

  return suggestions
}

/**
 * Find existing pending review by the current user
 */
async function findExistingPendingReview(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number | null> {
  try {
    const response = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber
    })

    // Find the most recent pending review by the current user
    const pendingReview = response.data
      .filter((review) => review.state === 'PENDING')
      .sort(
        (a, b) =>
          new Date(b.submitted_at || '').getTime() -
          new Date(a.submitted_at || '').getTime()
      )[0]

    return pendingReview?.id || null
  } catch (error) {
    core.warning(`Failed to find existing pending review: ${error}`)
    return null
  }
}

/**
 * Submit existing pending review to clear it
 */
async function submitPendingReview(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number
): Promise<void> {
  try {
    await octokit.rest.pulls.submitReview({
      owner,
      repo,
      pull_number: prNumber,
      review_id: reviewId,
      event: 'COMMENT'
    })
    core.info(`✅ Submitted existing pending review #${reviewId}`)
  } catch (error) {
    core.warning(`Failed to submit pending review: ${error}`)
  }
}

/**
 * Create GitHub commit suggestions on a pull request
 */
export async function createPRCommitSuggestions(
  octokit: ReturnType<typeof github.getOctokit>,
  suggestionData: PRSuggestionData
): Promise<void> {
  const { owner, repo, prNumber, suggestions, eventType } = suggestionData

  if (suggestions.length === 0) {
    core.info('No suggestions to create')
    return
  }

  try {
    // Check if we have permission to create suggestions
    try {
      await octokit.rest.repos.get({
        owner,
        repo
      })
    } catch (error: unknown) {
      const githubError = error as { status?: number }
      if (githubError.status === 403) {
        core.error(
          '❌ Permission denied: Cannot access repository. Make sure the GitHub token has "pull-requests: write" permission.'
        )
        return
      }
      throw error
    }

    // Get PR details to get the head SHA
    const prResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber
    })

    const headSha = prResponse.data.head.sha

    // Submit existing pending reviews to clear them
    const existingPendingReviewId = await findExistingPendingReview(
      octokit,
      owner,
      repo,
      prNumber
    )
    if (existingPendingReviewId) {
      await submitPendingReview(
        octokit,
        owner,
        repo,
        prNumber,
        existingPendingReviewId
      )
    }

    // Create all suggestions in a single review
    if (suggestions.length > 0) {
      core.info(`Creating review with ${suggestions.length} suggestions`)

      const comments = suggestions.map((suggestion) => ({
        path: suggestion.filePath,
        position: suggestion.lineNumber,
        body: `**Acrolinx Suggestion**\n\n\`\`\`suggestion\n${suggestion.suggestion}\n\`\`\`\n\nThis suggestion was automatically generated by the Acrolinx Analyzer.`
      }))

      core.info(`Comment details: ${JSON.stringify(comments, null, 2)}`)

      const review = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        comments,
        body: `🤖 Acrolinx Analysis Suggestions\n\nThis review contains ${suggestions.length} suggestion(s) from the Acrolinx Analyzer for the **${eventType}** event.`
      })

      if (review.status === 200) {
        core.info(
          `✅ Created ${suggestions.length} suggestions for PR #${prNumber}`
        )
      } else {
        core.error(
          `❌ Failed to create ${suggestions.length} suggestions for PR #${prNumber}`
        )
      }
    } else {
      core.info('No suggestions to create')
    }
  } catch (error: unknown) {
    const githubError = handleGitHubError(error, 'Create PR commit suggestions')

    if (githubError.status === 403) {
      core.error(
        '❌ Permission denied: Cannot create commit suggestions on pull requests.'
      )
      core.error(
        'Please ensure the GitHub token has "pull-requests: write" permission.'
      )
    } else if (githubError.status === 404) {
      core.error(
        '❌ Pull request not found. Make sure the PR exists and is accessible.'
      )
    } else {
      logError(githubError, 'Failed to create commit suggestions')
    }
  }
}

/**
 * Check if commit suggestions are enabled
 */
export function isCommitSuggestionsEnabled(): boolean {
  return github.context.eventName === 'pull_request'
}
