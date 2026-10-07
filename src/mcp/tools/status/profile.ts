import { getProfileService } from '../../../services/profile.service'
import { type ActionHandler } from '../action-tool'

export const profileHandler: ActionHandler = {
  run() {
    const { stats, thoughts } = getProfileService()
    return { stats, thoughts }
  }
}
