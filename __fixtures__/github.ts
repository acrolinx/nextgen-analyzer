import type * as github from '@actions/github'
import { jest } from '@jest/globals'

export const getOctokit = jest.fn<typeof github.getOctokit>()

export const context = {
  eventName: 'pull_request',
  issue: {
    number: 123
  },
  repo: {
    owner: 'test-owner',
    repo: 'test-repo'
  },
  sha: 'abc123456789',
  payload: {
    pull_request: {
      base: {
        ref: 'main'
      }
    }
  }
} as github.Context
