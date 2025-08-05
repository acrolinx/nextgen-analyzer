/**
 * Rewrite service for handling Acrolinx rewrites and GitHub integration
 */

import * as core from '@actions/core'
import * as github from '@actions/github'
import { AcrolinxRewriteResult } from '../types/index.js'
import { rewriteFiles } from './acrolinx-service.js'
import { createAcrolinxConfig } from './acrolinx-service.js'
import { getRewriteOptions } from '../config/action-config.js'
import { ActionConfig } from '../types/index.js'
import { logError } from '../utils/error-utils.js'

/**
 * Interface for rewrite branch data
 */
export interface RewriteBranchData {
  branchName: string
  prNumber: number
  commitSha: string
  rewrittenFiles: AcrolinxRewriteResult[]
}

/**
 * Create rewrite branch with rewritten files
 */
export async function createRewriteBranch(
  octokit: ReturnType<typeof github.getOctokit>,
  config: ActionConfig,
  files: string[],
  readFileContent: (filePath: string) => Promise<string | null>
): Promise<RewriteBranchData | null> {
  try {
    const { owner, repo } = github.context.repo
    const prNumber = github.context.issue.number
    const commitSha = github.context.sha
    // Use the head branch (working branch) as the base for rewrite branch to avoid conflicts
    const headBranch = github.context.payload.pull_request?.head.ref || 'main'

    // Generate consistent branch name (without commit SHA to allow reuse)
    const branchName = `acrolinx-rewrite-${prNumber}`

    core.info(`🔄 Processing rewrite branch: ${branchName}`)

    // Check if branch already exists
    let branchExists = false
    try {
      await octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: branchName
      })
      branchExists = true
      core.info(`Branch ${branchName} already exists, will update it`)
    } catch {
      // Branch doesn't exist, will create it
      core.info(`Branch ${branchName} doesn't exist, will create it`)
    }

    // Run Acrolinx rewrites
    const acrolinxConfig = createAcrolinxConfig(config.acrolinxApiToken)
    const rewriteOptions = getRewriteOptions(config)

    core.info(`🚀 Starting Acrolinx rewrites for ${files.length} files`)
    const rewrittenFiles = await rewriteFiles(
      files,
      rewriteOptions,
      acrolinxConfig,
      readFileContent
    )

    if (rewrittenFiles.length === 0) {
      core.info('No files were successfully rewritten')
      return null
    }

    if (!branchExists) {
      // Create new branch from head branch (working branch) to avoid conflicts
      await createBranchFromBase(octokit, owner, repo, branchName, headBranch)
    } else {
      // Update existing branch to latest head branch state
      await updateBranchToLatest(octokit, owner, repo, branchName, headBranch)
    }

    // Apply rewritten files to the branch
    await applyRewrittenFiles(octokit, owner, repo, branchName, rewrittenFiles)

    // Commit the changes
    await commitRewrittenFiles(octokit, owner, repo, branchName, rewrittenFiles)

    core.info(
      `✅ Rewrite branch ${branchExists ? 'updated' : 'created'} successfully: ${branchName}`
    )

    return {
      branchName,
      prNumber,
      commitSha,
      rewrittenFiles
    }
  } catch (error) {
    logError(error, 'Failed to create rewrite branch')
    return null
  }
}

/**
 * Create a new branch from base branch
 */
async function createBranchFromBase(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  baseBranch: string
): Promise<void> {
  try {
    // Get the latest commit SHA from base branch
    const baseRef = await octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: baseBranch
    })

    // Create new branch from base branch
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.data.commit.sha
    })

    core.info(`✅ Created branch ${branchName} from ${baseBranch}`)
  } catch (error) {
    logError(error, `Failed to create branch ${branchName}`)
    throw error
  }
}

/**
 * Update an existing branch to the latest state of the base branch
 */
async function updateBranchToLatest(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  baseBranch: string
): Promise<void> {
  try {
    // Get the latest commit SHA from base branch
    const baseRef = await octokit.rest.repos.getBranch({
      owner,
      repo,
      branch: baseBranch
    })

    // Update the branch to point to the latest commit SHA
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseRef.data.commit.sha
    })

    core.info(
      `✅ Updated branch ${branchName} to latest state of ${baseBranch}`
    )
  } catch (error) {
    logError(error, `Failed to update branch ${branchName}`)
    throw error
  }
}

/**
 * Apply rewritten files to the branch
 */
async function applyRewrittenFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  rewrittenFiles: AcrolinxRewriteResult[]
): Promise<void> {
  try {
    for (const rewriteResult of rewrittenFiles) {
      // Get the current SHA of the file from the base branch
      let fileSha: string | undefined
      try {
        const fileResponse = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: rewriteResult.filePath,
          ref: branchName
        })

        if (Array.isArray(fileResponse.data)) {
          // This shouldn't happen for files, but handle it gracefully
          core.warning(
            `Path ${rewriteResult.filePath} is a directory, skipping`
          )
          continue
        }

        fileSha = fileResponse.data.sha
      } catch {
        // File doesn't exist yet, which is fine for new files
        core.info(
          `File ${rewriteResult.filePath} doesn't exist yet, creating new file`
        )
      }

      // Create or update file in the branch
      await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: rewriteResult.filePath,
        message: `Apply Acrolinx suggestions to ${rewriteResult.filePath}`,
        content: Buffer.from(rewriteResult.rewrittenContent).toString('base64'),
        branch: branchName,
        sha: fileSha // This will be undefined for new files, which is fine
      })

      core.info(`✅ Applied rewrite to ${rewriteResult.filePath}`)
    }
  } catch (error) {
    logError(error, 'Failed to apply rewritten files')
    throw error
  }
}

/**
 * Commit rewritten files with descriptive message
 */
async function commitRewrittenFiles(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  branchName: string,
  rewrittenFiles: AcrolinxRewriteResult[]
): Promise<void> {
  try {
    // The files are already committed by createOrUpdateFileContents
    // This function is for future use if we need to create a single commit
    core.info(`✅ Committed ${rewrittenFiles.length} rewritten files`)
  } catch (error) {
    logError(error, 'Failed to commit rewritten files')
    throw error
  }
}

/**
 * Create pull request for rewrite branch
 */
export async function createRewritePullRequest(
  octokit: ReturnType<typeof github.getOctokit>,
  rewriteData: RewriteBranchData
): Promise<string | null> {
  try {
    const { owner, repo } = github.context.repo
    // Target the head branch of the current PR (the working branch), not the base branch
    const targetBranch = github.context.payload.pull_request?.head.ref || 'main'

    // Check if PR already exists
    const existingPRs = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${rewriteData.branchName}`
    })

    if (existingPRs.data.length > 0) {
      core.info(`PR already exists for branch ${rewriteData.branchName}`)
      return existingPRs.data[0].html_url
    }

    // Create PR
    const pr = await octokit.rest.pulls.create({
      owner,
      repo,
      title: `🤖 Acrolinx Suggestions - PR #${rewriteData.prNumber}`,
      body: generateRewritePRBody(rewriteData),
      head: rewriteData.branchName,
      base: targetBranch
    })

    core.info(`✅ Created rewrite PR: ${pr.data.html_url}`)
    return pr.data.html_url
  } catch (error) {
    logError(error, 'Failed to create rewrite pull request')
    return null
  }
}

/**
 * Generate PR body for rewrite pull request
 */
function generateRewritePRBody(rewriteData: RewriteBranchData): string {
  const fileList = rewriteData.rewrittenFiles
    .map((f) => `- \`${f.filePath}\``)
    .join('\n')

  return `## 🤖 Acrolinx Suggestions

This pull request contains Acrolinx-generated improvements for better clarity, grammar, and style consistency.

### 📊 Summary
- **Files updated**: ${rewriteData.rewrittenFiles.length}
- **Original PR**: #${rewriteData.prNumber}
- **Commit SHA**: \`${rewriteData.commitSha}\`

### 📝 Files with suggestions
${fileList}

### 💡 How to apply
1. Review the changes in this PR
2. If you're satisfied with the suggestions, merge this PR
3. The changes will be automatically applied to your original PR

### ⚠️ Important
- This PR is automatically generated and will be cleaned up after 7 days
- Only merge if you're satisfied with all the suggestions
- You can also manually apply specific changes from this PR to your original PR

---
*Generated by Acrolinx Analyzer GitHub Action*`
}

/**
 * Clean up old rewrite branches
 */
export async function cleanupOldRewriteBranches(
  octokit: ReturnType<typeof github.getOctokit>,
  maxAgeDays: number = 7
): Promise<void> {
  try {
    const { owner, repo } = github.context.repo
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays)

    const branches = await octokit.rest.repos.listBranches({
      owner,
      repo
    })

    const rewriteBranches = branches.data.filter((branch) =>
      branch.name.startsWith('acrolinx-rewrite-')
    )

    for (const branch of rewriteBranches) {
      const lastCommit = await octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: branch.name
      })

      const commitDate = new Date(lastCommit.data.commit.author?.date || '')
      if (commitDate < cutoffDate) {
        try {
          await octokit.rest.git.deleteRef({
            owner,
            repo,
            ref: `heads/${branch.name}`
          })
          core.info(`🗑️ Deleted old rewrite branch: ${branch.name}`)
        } catch (error) {
          core.warning(`Failed to delete branch ${branch.name}: ${error}`)
        }
      }
    }
  } catch (error) {
    logError(error, 'Failed to cleanup old rewrite branches')
  }
}
