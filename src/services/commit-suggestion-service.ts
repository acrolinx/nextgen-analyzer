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
 * Convert diff to GitHub suggestion format
 */
function diffToSuggestion(diff: string): string {
  const lines = diff.split('\n')
  const suggestions: string[] = []

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('++')) {
      // This is an addition, suggest it
      suggestions.push(line.substring(1))
    }
  }

  return suggestions.join('\n')
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

  // If no difference found, return the last line
  return originalLines.length
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

      // Convert diff to suggestion
      const suggestion = diffToSuggestion(diff)

      if (!suggestion.trim()) {
        continue
      }

      // Find line number for suggestion
      const lineNumber = findSuggestionLineNumber(
        originalContent,
        result.rewrite
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

    // Create suggestions in batches
    const batchSize = 10 // GitHub API limit for review comments
    for (let i = 0; i < suggestions.length; i += batchSize) {
      const batch = suggestions.slice(i, i + batchSize)

      const comments = batch.map((suggestion) => ({
        path: suggestion.filePath,
        position: suggestion.lineNumber,
        body: `**Acrolinx Suggestion**\n\n\`\`\`suggestion\n${suggestion.suggestion}\n\`\`\`\n\nThis suggestion was automatically generated by the Acrolinx Analyzer.`
      }))

      const review = await octokit.rest.pulls.createReview({
        owner,
        event: 'REQUEST_CHANGES',
        repo,
        pull_number: prNumber,
        commit_id: headSha,
        comments,
        body: `🤖 Acrolinx Analysis Suggestions\n\nThis review contains ${batch.length} suggestion(s) from the Acrolinx Analyzer for the **${eventType}** event.`
      })

      if (review.status === 200) {
        core.info(`✅ Created ${batch.length} suggestions for PR #${prNumber}`)
      } else {
        core.error(
          `❌ Failed to create ${batch.length} suggestions for PR #${prNumber}`
        )
      }

      core.info(`✅ Created ${batch.length} suggestions for PR #${prNumber}`)
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
