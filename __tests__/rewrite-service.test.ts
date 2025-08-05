/**
 * Unit tests for rewrite service
 */

import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

// Mock @actions/core
jest.unstable_mockModule('@actions/core', () => core)

// Mock @actions/github
jest.unstable_mockModule('@actions/github', () => ({
  getOctokit: jest.fn(),
  context: {
    eventName: 'pull_request',
    issue: { number: 123 },
    repo: { owner: 'test-owner', repo: 'test-repo' },
    sha: 'abc123456789',
    payload: {
      pull_request: {
        base: { ref: 'main' },
        head: { ref: 'feature-branch' }
      }
    }
  }
}))

describe('Rewrite Service', () => {
  let mockOctokit: {
    rest: {
      repos: {
        getBranch: jest.MockedFunction<() => Promise<unknown>>
        createOrUpdateFileContents: jest.MockedFunction<() => Promise<unknown>>
        listBranches: jest.MockedFunction<() => Promise<unknown>>
        getCommit: jest.MockedFunction<() => Promise<unknown>>
      }
      git: {
        createRef: jest.MockedFunction<() => Promise<unknown>>
        deleteRef: jest.MockedFunction<() => Promise<unknown>>
      }
      pulls: {
        list: jest.MockedFunction<() => Promise<unknown>>
        create: jest.MockedFunction<() => Promise<unknown>>
      }
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()

    mockOctokit = {
      rest: {
        repos: {
          getBranch: jest.fn(),
          createOrUpdateFileContents: jest.fn(),
          listBranches: jest.fn(),
          getCommit: jest.fn()
        },
        git: {
          createRef: jest.fn(),
          deleteRef: jest.fn()
        },
        pulls: {
          list: jest.fn(),
          create: jest.fn()
        }
      }
    }
  })

  describe('createRewritePullRequest', () => {
    it('should create pull request successfully', async () => {
      const rewriteData = {
        branchName: 'acrolinx-rewrite-123-abc12345',
        prNumber: 123,
        commitSha: 'abc123456789',
        rewrittenFiles: [
          {
            filePath: 'test1.md',
            originalContent: 'original',
            rewrittenContent: 'rewritten',
            result: { quality: 85 },
            timestamp: '2023-01-01T00:00:00Z'
          }
        ]
      }

      // Mock no existing PRs
      mockOctokit.rest.pulls.list = jest.fn().mockResolvedValue({
        data: []
      })

      // Mock PR creation
      mockOctokit.rest.pulls.create = jest.fn().mockResolvedValue({
        data: { html_url: 'https://github.com/test/pr/456' }
      })

      const { createRewritePullRequest } = await import(
        '../src/services/rewrite-service.js'
      )

      const result = await createRewritePullRequest(mockOctokit, rewriteData)

      expect(result).toBe('https://github.com/test/pr/456')
      expect(mockOctokit.rest.pulls.create).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        title: '🤖 Acrolinx Suggestions - PR #123',
        body: expect.stringContaining('Acrolinx Suggestions'),
        head: 'acrolinx-rewrite-123-abc12345',
        base: 'feature-branch'
      })
    })

    it('should return existing PR URL if PR already exists', async () => {
      const rewriteData = {
        branchName: 'acrolinx-rewrite-123-abc12345',
        prNumber: 123,
        commitSha: 'abc123456789',
        rewrittenFiles: []
      }

      // Mock existing PR
      mockOctokit.rest.pulls.list = jest.fn().mockResolvedValue({
        data: [{ html_url: 'https://github.com/test/pr/456' }]
      })

      const { createRewritePullRequest } = await import(
        '../src/services/rewrite-service.js'
      )

      const result = await createRewritePullRequest(mockOctokit, rewriteData)

      expect(result).toBe('https://github.com/test/pr/456')
      expect(mockOctokit.rest.pulls.create).not.toHaveBeenCalled()
      expect(core.info).toHaveBeenCalledWith(
        'PR already exists for branch acrolinx-rewrite-123-abc12345'
      )
    })

    it('should handle errors gracefully', async () => {
      const rewriteData = {
        branchName: 'acrolinx-rewrite-123-abc12345',
        prNumber: 123,
        commitSha: 'abc123456789',
        rewrittenFiles: []
      }

      mockOctokit.rest.pulls.list = jest
        .fn()
        .mockRejectedValue(new Error('API Error'))

      const { createRewritePullRequest } = await import(
        '../src/services/rewrite-service.js'
      )

      const result = await createRewritePullRequest(mockOctokit, rewriteData)

      expect(result).toBeNull()
    })
  })

  describe('cleanupOldRewriteBranches', () => {
    it('should cleanup old branches successfully', async () => {
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)

      const recentDate = new Date()
      recentDate.setDate(recentDate.getDate() - 2)

      // Mock branches
      mockOctokit.rest.repos.listBranches = jest.fn().mockResolvedValue({
        data: [
          { name: 'acrolinx-rewrite-123-old', commit: { sha: 'old-sha' } },
          {
            name: 'acrolinx-rewrite-123-recent',
            commit: { sha: 'recent-sha' }
          },
          { name: 'main', commit: { sha: 'main-sha' } }
        ]
      })

      // Mock commit dates
      mockOctokit.rest.repos.getCommit = jest
        .fn()
        .mockResolvedValueOnce({
          data: { commit: { author: { date: oldDate.toISOString() } } }
        })
        .mockResolvedValueOnce({
          data: { commit: { author: { date: recentDate.toISOString() } } }
        })

      // Mock branch deletion
      mockOctokit.rest.git.deleteRef = jest.fn().mockResolvedValue({})

      const { cleanupOldRewriteBranches } = await import(
        '../src/services/rewrite-service.js'
      )

      await cleanupOldRewriteBranches(mockOctokit, 7)

      expect(mockOctokit.rest.git.deleteRef).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        ref: 'heads/acrolinx-rewrite-123-old'
      })

      expect(core.info).toHaveBeenCalledWith(
        '🗑️ Deleted old rewrite branch: acrolinx-rewrite-123-old'
      )
    })

    it('should handle deletion errors gracefully', async () => {
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)

      mockOctokit.rest.repos.listBranches = jest.fn().mockResolvedValue({
        data: [{ name: 'acrolinx-rewrite-123-old', commit: { sha: 'old-sha' } }]
      })

      mockOctokit.rest.repos.getCommit = jest.fn().mockResolvedValue({
        data: { commit: { author: { date: oldDate.toISOString() } } }
      })

      mockOctokit.rest.git.deleteRef = jest
        .fn()
        .mockRejectedValue(new Error('Delete failed'))

      const { cleanupOldRewriteBranches } = await import(
        '../src/services/rewrite-service.js'
      )

      await cleanupOldRewriteBranches(mockOctokit, 7)

      expect(core.warning).toHaveBeenCalledWith(
        'Failed to delete branch acrolinx-rewrite-123-old: Error: Delete failed'
      )
    })

    it('should handle API errors gracefully', async () => {
      mockOctokit.rest.repos.listBranches = jest
        .fn()
        .mockRejectedValue(new Error('API Error'))

      const { cleanupOldRewriteBranches } = await import(
        '../src/services/rewrite-service.js'
      )

      await cleanupOldRewriteBranches(mockOctokit, 7)

      // Test that the function completes without throwing
      expect(true).toBe(true)
    })
  })
})
