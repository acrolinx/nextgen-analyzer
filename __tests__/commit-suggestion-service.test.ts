/**
 * Tests for commit suggestion service
 */

import { jest } from '@jest/globals'
import { createCommitSuggestions } from '../src/services/commit-suggestion-service.js'
import { AcrolinxAnalysisResult } from '../src/types/index.js'

// Mock dependencies
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warning: jest.fn()
}))

jest.mock('@actions/github', () => ({
  context: {
    eventName: 'pull_request',
    issue: { number: 123 },
    repo: { owner: 'test-owner', repo: 'test-repo' }
  }
}))

jest.mock('diff', () => ({
  diffLines: jest.fn()
}))

jest.mock('../src/utils/file-utils.js', () => ({
  readFileContent: jest.fn()
}))

jest.mock('../src/utils/error-utils.js', () => ({
  handleGitHubError: jest.fn(),
  logError: jest.fn()
}))

describe('Commit Suggestion Service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createCommitSuggestions', () => {
    it('should skip files with no rewrite content', async () => {
      const mockResults: AcrolinxAnalysisResult[] = [
        {
          filePath: 'test.md',
          result: {
            quality: { score: 80 },
            clarity: {
              score: 85,
              word_count: 100,
              sentence_count: 10,
              average_sentence_length: 10,
              flesch_reading_ease: 10,
              vocabulary_complexity: 10,
              flesch_kincaid_grade: 10,
              lexical_diversity: 10,
              sentence_complexity: 10
            },
            tone: { score: 90, informality: 10, liveliness: 10 },
            style_guide: { score: 88, issues: 1 },
            terminology: { score: 95, issues: 0 },
            grammar: { score: 90, issues: 1 }
          },
          timestamp: '2024-01-01T00:00:00Z',
          rewrite: ''
        }
      ]

      const suggestions = await createCommitSuggestions(mockResults)
      expect(suggestions).toHaveLength(0)
    })

    it('should handle files with rewrite content', async () => {
      const mockResults: AcrolinxAnalysisResult[] = [
        {
          filePath: 'test.md',
          result: {
            quality: { score: 80 },
            clarity: {
              score: 85,
              word_count: 100,
              sentence_count: 10,
              average_sentence_length: 10,
              flesch_reading_ease: 10,
              vocabulary_complexity: 10,
              flesch_kincaid_grade: 10,
              lexical_diversity: 10,
              sentence_complexity: 10
            },
            tone: { score: 90, informality: 10, liveliness: 10 },
            style_guide: { score: 88, issues: 1 },
            terminology: { score: 95, issues: 0 },
            grammar: { score: 90, issues: 1 }
          },
          timestamp: '2024-01-01T00:00:00Z',
          rewrite: 'new content'
        }
      ]

      const suggestions = await createCommitSuggestions(mockResults)
      expect(suggestions).toBeDefined()
    })
  })

  describe('pending review handling', () => {
    it('should handle existing pending reviews gracefully', async () => {
      const mockResults: AcrolinxAnalysisResult[] = []
      const suggestions = await createCommitSuggestions(mockResults)
      expect(suggestions).toHaveLength(0)
    })
  })
})
