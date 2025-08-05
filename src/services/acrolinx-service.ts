/**
 * Acrolinx service for handling style analysis
 */

import * as core from '@actions/core'
import {
  Config,
  StyleAnalysisReq,
  StyleScores,
  styleRewrite,
  styleBatchRewrites
} from '@acrolinx/typescript-sdk'
import { AcrolinxAnalysisResult, AnalysisOptions } from '../types/index.js'
import { getFileBasename } from '../utils/file-utils.js'
import { calculateScoreSummary, ScoreSummary } from '../utils/score-utils.js'
import { processFileReading } from '../utils/batch-utils.js'

/**
 * Create Acrolinx configuration
 */
export function createAcrolinxConfig(apiToken: string): Config {
  return { apiKey: apiToken }
}

/**
 * Run Acrolinx style check on a single file
 */
export async function analyzeFile(
  filePath: string,
  content: string,
  options: AnalysisOptions,
  config: Config
): Promise<AcrolinxAnalysisResult | null> {
  try {
    core.info(`🔍 Running Acrolinx check on: ${filePath}`)

    const request: StyleAnalysisReq = {
      content,
      dialect: options.dialect,
      tone: options.tone,
      style_guide: options.styleGuide,
      documentName: getFileBasename(filePath)
    }

    const result = await styleRewrite(request, config)

    return {
      filePath,
      result: result.scores,
      timestamp: new Date().toISOString(),
      rewrite: result.rewrite
    }
  } catch (error) {
    core.error(`Failed to run Acrolinx check on ${filePath}: ${error}`)
    return null
  }
}

/**
 * Run Acrolinx analysis on multiple files using batch processing
 */
export async function analyzeFilesBatch(
  files: string[],
  options: AnalysisOptions,
  config: Config,
  readFileContent: (filePath: string) => Promise<string | null>
): Promise<AcrolinxAnalysisResult[]> {
  if (files.length === 0) {
    return []
  }

  core.info(`🚀 Starting batch analysis of ${files.length} files`)

  // Read all file contents first using optimized batch processing
  const fileContents = await processFileReading(files, readFileContent)

  if (fileContents.length === 0) {
    core.warning('No valid file contents found for analysis')
    return []
  }

  // Create batch requests
  const requests: StyleAnalysisReq[] = fileContents.map(
    ({ filePath, content }) => ({
      content,
      dialect: options.dialect,
      tone: options.tone,
      style_guide: options.styleGuide,
      documentName: getFileBasename(filePath)
    })
  )

  // Configure batch options with sensible defaults
  const batchOptions = {
    maxConcurrent: 100, // Limit concurrency to avoid overwhelming the API
    retryAttempts: 2,
    retryDelay: 1000,
    timeout: 300000 // 5 minutes
  }

  try {
    // Start batch processing
    const batchResponse = styleBatchRewrites(requests, config, batchOptions)

    // Monitor progress
    const progressInterval = setInterval(() => {
      const progress = batchResponse.progress
      const completed = progress.completed
      const failed = progress.failed
      const total = progress.total

      if (completed > 0 || failed > 0) {
        core.info(
          `📊 Batch progress: ${completed}/${total} completed, ${failed} failed`
        )
      }
    }, 2000) // Update every 2 seconds

    // Wait for completion
    const finalProgress = await batchResponse.promise

    // Clear progress monitoring
    clearInterval(progressInterval)

    // Process results
    const results: AcrolinxAnalysisResult[] = []
    finalProgress.results.forEach(
      (
        batchResult: {
          status: string
          result?: { scores: StyleScores; rewrite: string }
          error?: { message: string }
        },
        index: number
      ) => {
        if (batchResult.status === 'completed' && batchResult.result) {
          results.push({
            filePath: fileContents[index].filePath,
            result: batchResult.result.scores,
            timestamp: new Date().toISOString(),
            rewrite: batchResult.result.rewrite
          })
        } else if (batchResult.status === 'failed') {
          core.error(
            `Failed to analyze ${fileContents[index].filePath}: ${
              batchResult.error?.message || 'Unknown error'
            }`
          )
        }
      }
    )

    core.info(
      `✅ Batch analysis completed: ${results.length}/${fileContents.length} files processed successfully`
    )
    return results
  } catch (error) {
    core.error(`Batch analysis failed: ${error}`)
    return []
  }
}

/**
 * Run Acrolinx analysis on multiple files
 *
 * Uses batch processing for multiple files and sequential processing for small batches
 */
export async function analyzeFiles(
  files: string[],
  options: AnalysisOptions,
  config: Config,
  readFileContent: (filePath: string) => Promise<string | null>
): Promise<AcrolinxAnalysisResult[]> {
  // For small batches, use sequential processing
  if (files.length <= 3) {
    const results: AcrolinxAnalysisResult[] = []

    // Process files sequentially to avoid overwhelming the API
    for (const filePath of files) {
      const content = await readFileContent(filePath)
      if (content) {
        const result = await analyzeFile(filePath, content, options, config)
        if (result) {
          results.push(result)
        }
      }
    }

    return results
  }

  // For larger batches, use batch processing
  return analyzeFilesBatch(files, options, config, readFileContent)
}

/**
 * Get analysis summary statistics
 */
export function getAnalysisSummary(
  results: AcrolinxAnalysisResult[]
): ScoreSummary {
  const summary = calculateScoreSummary(results)
  return {
    totalFiles: summary.totalFiles,
    averageQualityScore: summary.averageQualityScore,
    averageClarityScore: summary.averageClarityScore,
    averageToneScore: summary.averageToneScore,
    averageGrammarScore: summary.averageGrammarScore,
    averageStyleGuideScore: summary.averageStyleGuideScore,
    averageTerminologyScore: summary.averageTerminologyScore
  }
}
