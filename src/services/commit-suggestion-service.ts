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
 * Create file-level suggestion (entire rewritten content)
 */
function createFileSuggestion(
  originalContent: string,
  rewrittenContent: string
): string {
  // Return the entire rewritten content as the suggestion
  return rewrittenContent
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

      // Find line number for suggestion - always start at line 1 for file-level suggestions
      const lineNumber = 1

      core.info(
        `Processing suggestion for ${result.filePath}: line ${lineNumber}, suggestion length: ${suggestion.length}`
      )

      // Debug: Log the first few lines of the suggestion
      const suggestionLines = suggestion.split('\n')
      core.info(
        `Suggestion preview for ${result.filePath}: ${suggestionLines.slice(0, 3).join(' | ')}`
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
 * Find existing suggestions for the given files
 */
async function findExistingSuggestions(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  filePaths: string[]
): Promise<Map<string, number>> {
  try {
    const reviews = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber
    })

    const existingSuggestions = new Map<string, number>()

    for (const review of reviews.data) {
      if (review.user?.login === github.context.actor) {
        // Get review comments for this review
        const comments = await octokit.rest.pulls.listReviewComments({
          owner,
          repo,
          pull_number: prNumber,
          review_id: review.id
        })

        for (const comment of comments.data) {
          if (comment.body?.includes('```suggestion')) {
            const filePath = comment.path
            if (filePaths.includes(filePath)) {
              existingSuggestions.set(filePath, comment.id)
            }
          }
        }
      }
    }

    return existingSuggestions
  } catch (error) {
    core.warning(`Failed to find existing suggestions: ${error}`)
    return new Map()
  }
}

/**
 * Update existing suggestion comment
 */
async function updateSuggestionComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  suggestion: string
): Promise<void> {
  try {
    await octokit.rest.pulls.updateReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      comment_id: commentId,
      body: `\`\`\`suggestion\n${suggestion}\n\`\`\``
    })
    core.info(
      `✅ Updated existing suggestion for comment ${commentId} at line 1`
    )
  } catch (error) {
    core.warning(`Failed to update suggestion comment ${commentId}: ${error}`)
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

    // Find existing suggestions
    const filePaths = suggestions.map((s) => s.filePath)
    const existingSuggestions = await findExistingSuggestions(
      octokit,
      owner,
      repo,
      prNumber,
      filePaths
    )

    // Separate suggestions into new and existing
    const newSuggestions: CommitSuggestion[] = []
    const updatePromises: Promise<void>[] = []

    for (const suggestion of suggestions) {
      const existingCommentId = existingSuggestions.get(suggestion.filePath)

      if (existingCommentId) {
        // Update existing suggestion
        updatePromises.push(
          updateSuggestionComment(
            octokit,
            owner,
            repo,
            prNumber,
            existingCommentId,
            suggestion.suggestion
          )
        )
        core.info(
          `🔄 Will update existing suggestion for ${suggestion.filePath}`
        )
      } else {
        // Create new suggestion
        newSuggestions.push(suggestion)
        core.info(`➕ Will create new suggestion for ${suggestion.filePath}`)
      }
    }

    // Update existing suggestions
    if (updatePromises.length > 0) {
      core.info(`Updating ${updatePromises.length} existing suggestions`)
      await Promise.all(updatePromises)
    }

    // Create new suggestions
    if (newSuggestions.length > 0) {
      core.info(`Creating ${newSuggestions.length} new suggestions`)

      const comments = newSuggestions.map((suggestion) => ({
        path: suggestion.filePath,
        position: 1, // Always start at line 1 for file-level suggestions
        body: `\`\`\`suggestion\n${suggestion.suggestion}\n\`\`\``
      }))

      core.info(`Comment details: ${JSON.stringify(comments, null, 2)}`)
      core.info(
        `Creating review with ${newSuggestions.length} suggestions at line 1`
      )

      const review = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        comments,
        body: `🤖 Acrolinx Analysis Suggestions\n\nThis review contains ${newSuggestions.length} new suggestion(s) from the Acrolinx Analyzer for the **${eventType}** event.`,
        event: 'COMMENT' // Submit the review immediately
      })

      if (review.status === 200) {
        core.info(
          `✅ Created ${newSuggestions.length} new suggestions for PR #${prNumber}`
        )
        core.info(`Review ID: ${review.data.id}`)
        core.info(`Review state: ${review.data.state}`)
      } else {
        core.error(
          `❌ Failed to create ${newSuggestions.length} new suggestions for PR #${prNumber}`
        )
      }
    } else {
      core.info('No new suggestions to create')
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
