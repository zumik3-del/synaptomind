import { createErrorHandler } from '../middleware/http-errors'

export const errorHandler = createErrorHandler('json')
