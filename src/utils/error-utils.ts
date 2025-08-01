/**
 * Centralized error handling and retry utilities
 */

import * as core from '@actions/core'

/**
 * Retry configuration options
 */
export interface RetryConfig {
  maxRetries: number
  baseDelay: number
  maxDelay: number
  backoffMultiplier: number
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2
}

/**
 * Error types for better error handling
 */
export class GitHubAPIError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message)
    this.name = 'GitHubAPIError'
  }
}

export class AcrolinxAPIError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string
  ) {
    super(message)
    this.name = 'AcrolinxAPIError'
  }
}

/**
 * Utility function for delay with exponential backoff
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Calculate delay with exponential backoff
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig
): number {
  const delay =
    config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1)
  return Math.min(delay, config.maxDelay)
}

/**
 * Generic retry function with exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  operationName: string = 'Operation'
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt === config.maxRetries) {
        core.error(
          `${operationName} failed after ${config.maxRetries} attempts: ${lastError.message}`
        )
        throw lastError
      }

      const backoffDelay = calculateBackoffDelay(attempt, config)
      core.warning(
        `Attempt ${attempt} failed for ${operationName}, retrying in ${backoffDelay}ms... Error: ${lastError.message}`
      )

      await delay(backoffDelay)
    }
  }

  // This should never be reached, but TypeScript requires it
  throw lastError || new Error(`${operationName} failed`)
}

/**
 * Handle GitHub API errors with proper typing
 */
export function handleGitHubError(
  error: unknown,
  context: string
): GitHubAPIError {
  if (error instanceof GitHubAPIError) {
    return error
  }

  if (error && typeof error === 'object' && 'status' in error) {
    const githubError = error as { status?: number; message?: string }
    return new GitHubAPIError(
      `${context}: ${githubError.message || 'Unknown GitHub API error'}`,
      githubError.status
    )
  }

  return new GitHubAPIError(
    `${context}: ${error instanceof Error ? error.message : String(error)}`
  )
}

/**
 * Handle Acrolinx API errors with proper typing
 */
export function handleAcrolinxError(
  error: unknown,
  context: string
): AcrolinxAPIError {
  if (error instanceof AcrolinxAPIError) {
    return error
  }

  if (error && typeof error === 'object' && 'status' in error) {
    const acrolinxError = error as { status?: number; message?: string }
    return new AcrolinxAPIError(
      `${context}: ${acrolinxError.message || 'Unknown Acrolinx API error'}`,
      acrolinxError.status
    )
  }

  return new AcrolinxAPIError(
    `${context}: ${error instanceof Error ? error.message : String(error)}`
  )
}

/**
 * Check if an error is a network-related error
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const networkErrorCodes = [
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENETUNREACH'
  ]

  return networkErrorCodes.some((code) => error.message.includes(code))
}

/**
 * Check if an error is a rate limit error
 */
export function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('rate limit') ||
    (error instanceof GitHubAPIError && error.status === 403)
  )
}

/**
 * Log error with context
 */
export function logError(error: unknown, context: string): void {
  if (error instanceof Error) {
    core.error(`${context}: ${error.message}`)
    if (error.stack) {
      core.debug(`Stack trace: ${error.stack}`)
    }
  } else {
    core.error(`${context}: ${String(error)}`)
  }
}
