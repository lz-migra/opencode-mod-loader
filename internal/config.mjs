import { readFileSync } from 'node:fs'
import path from 'node:path'

export function loadProjectConfig(rootDir) {
  const configPath = path.join(rootDir, 'config.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))

  if (!Number.isInteger(config.proxyPort) || config.proxyPort < 1 || config.proxyPort > 65535) {
    throw new Error(`Invalid proxyPort in ${configPath}: expected an integer from 1 to 65535`)
  }

  return config
}
