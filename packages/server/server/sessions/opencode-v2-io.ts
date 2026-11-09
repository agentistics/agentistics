/** opencode-v2-io.ts — binds `opencode-v2-api.ts` to this machine's opencode paths (see `config.ts`). */
import { OPENCODE_DB_PATH, OPENCODE_DIR } from '../config'
import { isOpencodeV2, opencodeStateDir, type V2Io } from './opencode-v2-api'

export const opencodeV2Io = (): V2Io => ({ stateDir: opencodeStateDir(OPENCODE_DIR) })
export const isOpencodeV2Now = (): boolean => isOpencodeV2(OPENCODE_DB_PATH, opencodeStateDir(OPENCODE_DIR))
