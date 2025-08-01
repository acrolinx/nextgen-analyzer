/**
 * Unit tests for score utilities
 */

import { jest } from '@jest/globals'
import * as core from '../__fixtures__/core.js'

// Mock @actions/core
jest.unstable_mockModule('@actions/core', () => core)

const {
  QUALITY_THRESHOLDS,
  getQualityStatus,
  getQualityEmoji,
  calculateAverageScore,
  calculateScoreSummary
} = await import('../src/utils/score-utils.js')

describe('Score Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('Constants', () => {
    it('should export quality thresholds', () => {
      expect(QUALITY_THRESHOLDS).toEqual({
        EXCELLENT: 80,
        GOOD: 60,
        POOR: 0
      })
    })
  })

  describe('getQualityStatus', () => {
    it('should return success for scores 80 and above', () => {
      expect(getQualityStatus(95)).toBe('success')
      expect(getQualityStatus(80)).toBe('success')
      expect(getQualityStatus(100)).toBe('success')
    })

    it('should return failure for scores 60-79', () => {
      expect(getQualityStatus(75)).toBe('failure')
      expect(getQualityStatus(60)).toBe('failure')
      expect(getQualityStatus(79)).toBe('failure')
    })

    it('should return error for scores below 60', () => {
      expect(getQualityStatus(55)).toBe('error')
      expect(getQualityStatus(0)).toBe('error')
      expect(getQualityStatus(30)).toBe('error')
    })
  })

  describe('getQualityEmoji', () => {
    it('should return green circle for scores 80 and above', () => {
      expect(getQualityEmoji(95)).toBe('🟢')
      expect(getQualityEmoji(80)).toBe('🟢')
      expect(getQualityEmoji(100)).toBe('🟢')
    })

    it('should return yellow circle for scores 60-79', () => {
      expect(getQualityEmoji(75)).toBe('🟡')
      expect(getQualityEmoji(60)).toBe('🟡')
      expect(getQualityEmoji(79)).toBe('🟡')
    })

    it('should return red circle for scores below 60', () => {
      expect(getQualityEmoji(55)).toBe('🔴')
      expect(getQualityEmoji(0)).toBe('🔴')
      expect(getQualityEmoji(30)).toBe('🔴')
    })
  })

  describe('calculateAverageScore', () => {
    it('should calculate average of quality scores', () => {
      const scores = [85, 90, 75, 95]
      const average = calculateAverageScore(scores)
      expect(average).toBe(86.25)
    })

    it('should handle single score', () => {
      const scores = [85]
      const average = calculateAverageScore(scores)
      expect(average).toBe(85)
    })

    it('should return 0 for empty array', () => {
      const scores: number[] = []
      const average = calculateAverageScore(scores)
      expect(average).toBe(0)
    })

    it('should handle decimal scores', () => {
      const scores = [85.5, 90.25, 75.75]
      const average = calculateAverageScore(scores)
      expect(average).toBe(83.83)
    })

    it('should handle zero scores', () => {
      const scores = [0, 50, 100]
      const average = calculateAverageScore(scores)
      expect(average).toBe(50)
    })
  })

  describe('calculateScoreSummary', () => {
    it('should calculate summary from analysis results', () => {
      const mockResults = [
        {
          filePath: 'file1.md',
          result: {
            quality: { score: 85 },
            clarity: { score: 78 },
            grammar: { score: 90, issues: 2 },
            style_guide: { score: 88, issues: 1 },
            tone: { score: 82 },
            terminology: { score: 95, issues: 0 }
          },
          timestamp: '2024-01-15T10:30:00Z'
        },
        {
          filePath: 'file2.md',
          result: {
            quality: { score: 90 },
            clarity: { score: 85 },
            grammar: { score: 88, issues: 1 },
            style_guide: { score: 92, issues: 0 },
            tone: { score: 87 },
            terminology: { score: 89, issues: 1 }
          },
          timestamp: '2024-01-15T10:35:00Z'
        }
      ]

      const summary = calculateScoreSummary(mockResults)

      expect(summary).toEqual({
        totalFiles: 2,
        averageQualityScore: 87.5,
        averageClarityScore: 81.5,
        averageToneScore: 84.5,
        averageGrammarScore: 89,
        averageStyleGuideScore: 90,
        averageTerminologyScore: 92
      })
    })

    it('should handle empty results array', () => {
      const summary = calculateScoreSummary([])

      expect(summary).toEqual({
        totalFiles: 0,
        averageQualityScore: 0,
        averageClarityScore: 0,
        averageToneScore: 0,
        averageGrammarScore: 0,
        averageStyleGuideScore: 0,
        averageTerminologyScore: 0
      })
    })

    it('should handle results with missing optional fields', () => {
      const mockResults = [
        {
          filePath: 'file1.md',
          result: {
            quality: { score: 85 },
            clarity: { score: 78 },
            grammar: { score: 90 }, // Missing issues
            style_guide: { score: 88 }, // Missing issues
            tone: { score: 82 },
            terminology: { score: 95 } // Missing issues
          },
          timestamp: '2024-01-15T10:30:00Z'
        }
      ]

      const summary = calculateScoreSummary(mockResults)

      expect(summary).toEqual({
        totalFiles: 1,
        averageQualityScore: 85,
        averageClarityScore: 78,
        averageToneScore: 82,
        averageGrammarScore: 90,
        averageStyleGuideScore: 88,
        averageTerminologyScore: 95
      })
    })

    it('should handle single result', () => {
      const mockResults = [
        {
          filePath: 'file1.md',
          result: {
            quality: { score: 85 },
            clarity: { score: 78 },
            grammar: { score: 90, issues: 2 },
            style_guide: { score: 88, issues: 1 },
            tone: { score: 82 },
            terminology: { score: 95, issues: 0 }
          },
          timestamp: '2024-01-15T10:30:00Z'
        }
      ]

      const summary = calculateScoreSummary(mockResults)

      expect(summary).toEqual({
        totalFiles: 1,
        averageQualityScore: 85,
        averageClarityScore: 78,
        averageToneScore: 82,
        averageGrammarScore: 90,
        averageStyleGuideScore: 88,
        averageTerminologyScore: 95
      })
    })

    it('should handle decimal scores correctly', () => {
      const mockResults = [
        {
          filePath: 'file1.md',
          result: {
            quality: { score: 85.5 },
            clarity: { score: 78.25 },
            grammar: { score: 90.75, issues: 2 },
            style_guide: { score: 88.5, issues: 1 },
            tone: { score: 82.25 },
            terminology: { score: 95.75, issues: 0 }
          },
          timestamp: '2024-01-15T10:30:00Z'
        }
      ]

      const summary = calculateScoreSummary(mockResults)

      expect(summary).toEqual({
        totalFiles: 1,
        averageQualityScore: 85.5,
        averageClarityScore: 78.25,
        averageToneScore: 82.25,
        averageGrammarScore: 90.75,
        averageStyleGuideScore: 88.5,
        averageTerminologyScore: 95.75
      })
    })
  })
})
