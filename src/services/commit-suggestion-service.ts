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
 * Convert diff to individual line suggestions
 */
function diffToSuggestions(diff: string): string[] {
  const lines = diff.split('\n')
  const suggestions: string[] = []
  let currentSuggestion: string[] = []
  let inAddition = false

  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('++')) {
      // Start or continue an addition block
      if (!inAddition) {
        inAddition = true
        currentSuggestion = []
      }
      currentSuggestion.push(line.substring(1))
    } else if (line.startsWith('-') && !line.startsWith('--')) {
      // Skip deletions, they're handled by the diff context
      continue
    } else if (line.startsWith('@') || line.startsWith(' ')) {
      // Context line or diff header - end current suggestion if we have one
      if (inAddition && currentSuggestion.length > 0) {
        suggestions.push(currentSuggestion.join('\n'))
        currentSuggestion = []
        inAddition = false
      }
    }
  }

  // Don't forget the last suggestion if we're still in an addition block
  if (inAddition && currentSuggestion.length > 0) {
    suggestions.push(currentSuggestion.join('\n'))
  }

  return suggestions
}

/**
 * Find line numbers for each suggestion
 */
function findSuggestionLineNumbers(
  originalContent: string,
  rewrittenContent: string
): number[] {
  const originalLines = originalContent.split('\n')
  const rewrittenLines = rewrittenContent.split('\n')
  const lineNumbers: number[] = []

  let i = 0
  while (i < Math.min(originalLines.length, rewrittenLines.length)) {
    if (originalLines[i] !== rewrittenLines[i]) {
      // Find the start of this continuous change
      const startLine = i + 1
      lineNumbers.push(startLine)

      // Skip to the end of this continuous change
      while (
        i < Math.min(originalLines.length, rewrittenLines.length) &&
        originalLines[i] !== rewrittenLines[i]
      ) {
        i++
      }
    } else {
      i++
    }
  }

  // If no changes found, add line after the last line
  if (lineNumbers.length === 0) {
    lineNumbers.push(originalLines.length + 1)
  }

  return lineNumbers
}

/**
 * Parse GitHub diff to find added and modified lines
 */
function parseGitHubDiff(diffContent: string): Map<string, number[]> {
  const addedLines = new Map<string, number[]>()
  const lines = diffContent.split('\n')
  let currentFile = ''
  let lineNumber = 0
  let inHunk = false
  let hunkStartLine = 0

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      // New file section
      const match = line.match(/diff --git a\/(.+) b\/(.+)/)
      if (match) {
        currentFile = match[1]
        addedLines.set(currentFile, [])
        inHunk = false
      }
    } else if (line.startsWith('@@')) {
      // Hunk header - parse line numbers
      const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/)
      if (match) {
        hunkStartLine = parseInt(match[3], 10) // Start line in the new version
        lineNumber = hunkStartLine
        inHunk = true
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      // Added line (could be new addition or modification)
      if (currentFile && addedLines.has(currentFile) && inHunk) {
        addedLines.get(currentFile)!.push(lineNumber)
      }
      lineNumber++
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed line
      // Don't increment line number for removals
    } else if (line.startsWith(' ')) {
      // Context line - increment line number
      lineNumber++
    } else {
      // Other lines (like file headers) - don't increment
    }
  }

  return addedLines
}

/**
 * Create commit suggestions from Acrolinx analysis results
 * Only creates suggestions for lines that are actually changed in the PR
 */
export async function createCommitSuggestions(
  results: AcrolinxAnalysisResult[],
  prChangedLines?: Map<string, number[]>
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

      // If we have PR changed lines, only process suggestions for those lines
      if (prChangedLines && prChangedLines.has(result.filePath)) {
        const changedLines = prChangedLines.get(result.filePath)!
        core.info(
          `📋 Processing suggestions for changed lines: ${changedLines.join(', ')} in ${result.filePath}`
        )

        // For each changed line, create a suggestion based on Acrolinx's rewrite
        for (const lineNumber of changedLines) {
          const originalLines = originalContent.split('\n')
          const rewrittenLines = result.rewrite.split('\n')

          if (
            lineNumber <= originalLines.length &&
            lineNumber <= rewrittenLines.length
          ) {
            const originalLine = originalLines[lineNumber - 1] || ''
            const rewrittenLine = rewrittenLines[lineNumber - 1] || ''

            if (originalLine !== rewrittenLine) {
              suggestions.push({
                filePath: result.filePath,
                originalContent,
                rewrittenContent: result.rewrite,
                diff: `- ${originalLine}\n+ ${rewrittenLine}`,
                lineNumber,
                suggestion: rewrittenLine
              })

              core.info(
                `✅ Created suggestion for ${result.filePath} at line ${lineNumber}`
              )
            }
          }
        }
      } else {
        // Fallback to original logic if no PR changed lines provided
        core.info(
          `📋 No PR changed lines info for ${result.filePath}, using original logic`
        )

        // Generate diff
        const diff = generateDiff(originalContent, result.rewrite)

        if (!diff.trim()) {
          continue
        }

        // Convert diff to suggestions
        const individualSuggestions = diffToSuggestions(diff)

        if (individualSuggestions.length === 0) {
          continue
        }

        // Find line numbers for each suggestion
        const lineNumbers = findSuggestionLineNumbers(
          originalContent,
          result.rewrite
        )

        core.info(`🔍 Acrolinx analysis for ${result.filePath}:`)
        core.info(
          `  📄 Original content has ${originalContent.split('\n').length} lines`
        )
        core.info(
          `  📄 Rewritten content has ${result.rewrite.split('\n').length} lines`
        )
        core.info(`  💡 Found ${individualSuggestions.length} suggestions`)
        core.info(
          `  📍 Line numbers from Acrolinx diff: ${lineNumbers.join(', ')}`
        )

        for (let i = 0; i < individualSuggestions.length; i++) {
          const suggestion = individualSuggestions[i]
          const lineNumber = lineNumbers[i]

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
        }
      }
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
      body: 'Submitted to make room for new Acrolinx suggestions',
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

    // Get the PR diff to understand which lines are added
    const diffResponse = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: {
        format: 'diff'
      }
    })

    const prDiff = diffResponse.data as unknown as string
    const addedLinesMap = parseGitHubDiff(prDiff)

    // Get the list of files changed in this PR
    const filesResponse = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber
    })

    const prFiles = filesResponse.data.map((file) => file.filename)

    // Create suggestions only for lines that are actually changed in the PR
    // We need to convert the existing suggestions to the new format
    const suggestionsForChangedLines = await createCommitSuggestions(
      [], // We'll handle this differently - use the existing suggestions
      addedLinesMap
    )

    // Log filtering results
    core.info('📊 Suggestion filtering results:')
    core.info(`  📄 Total suggestions: ${suggestions.length}`)
    core.info(`  ✅ Valid suggestions: ${suggestionsForChangedLines.length}`)

    if (suggestions.length > suggestionsForChangedLines.length) {
      const filteredCount =
        suggestions.length - suggestionsForChangedLines.length
      core.info(
        `  ❌ Filtered out: ${filteredCount} suggestions (not on added/modified lines)`
      )

      // Log the filtered out suggestions for debugging
      const filteredSuggestions = suggestions.filter(
        (suggestion) =>
          !suggestionsForChangedLines.some(
            (valid) =>
              valid.filePath === suggestion.filePath &&
              valid.lineNumber === suggestion.lineNumber
          )
      )

      if (filteredSuggestions.length > 0) {
        core.info('📋 Filtered out suggestions:')
        for (const suggestion of filteredSuggestions) {
          const addedLines = addedLinesMap.get(suggestion.filePath) || []
          core.info(
            `  📄 ${suggestion.filePath}: line ${suggestion.lineNumber} (not in added lines: ${addedLines.join(', ')})`
          )
          core.info(`    💡 Suggestion: "${suggestion.suggestion.trim()}"`)
        }
      }
    }

    if (suggestionsForChangedLines.length === 0) {
      core.info('No suggestions for added or modified lines in this PR')
      return
    }

    core.info(
      `Found ${suggestionsForChangedLines.length} suggestions for added/modified lines in ${prFiles.length} changed files`
    )

    // Create a single pending review with all suggestions
    // For suggestions, we need to use the correct format
    const comments = suggestionsForChangedLines.map((suggestion) => ({
      path: suggestion.filePath,
      line: suggestion.lineNumber,
      body: `**Acrolinx Suggestion**\n\n\`\`\`suggestion\n${suggestion.suggestion}\n\`\`\`\n\nThis suggestion was automatically generated by the Acrolinx Analyzer.`
    }))

    // GitHub API limit is 100 comments per review
    const maxComments = 100
    if (comments.length > maxComments) {
      core.warning(
        `⚠️ Too many suggestions (${comments.length}). Limiting to first ${maxComments} suggestions.`
      )
      comments.splice(maxComments)
    }

    core.info(`Creating single review with ${comments.length} suggestions`)

    if (comments.length === 0) {
      core.info('No suggestions to create')
      return
    }

    const review = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      comments,
      body: `🤖 Acrolinx Analysis Suggestions\n\nThis review contains ${comments.length} suggestion(s) from the Acrolinx Analyzer for the **${eventType}** event.`
    })

    if (review.status === 200) {
      core.info(`✅ Created ${comments.length} suggestions for PR #${prNumber}`)
    } else {
      core.error(
        `❌ Failed to create ${comments.length} suggestions for PR #${prNumber}`
      )
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
