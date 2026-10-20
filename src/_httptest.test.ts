import { beforeEach, afterEach, test, expect } from 'bun:test'
import { createTestDb, seedThought } from './test/helpers'
import { closeDb } from './db'
import { app } from './api/server' // maybe not
