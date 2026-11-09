import { installProcessHandlers } from '../process-handlers'

const requestedExit = process.argv[2]

installProcessHandlers()

if (requestedExit !== undefined) {
  process.exit(Number(requestedExit))
}

Promise.reject(new Error('fixture rejection'))

setTimeout(() => {
  throw new Error('fixture timer throw')
}, 0)

setTimeout(() => {
  console.log('SURVIVED')
}, 50)
