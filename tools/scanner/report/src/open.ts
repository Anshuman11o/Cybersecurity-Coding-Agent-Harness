/**
 * Open a file in the user's default browser. Best effort: a missing opener or
 * a machine with no display is not an error, because the path is always
 * printed as well.
 */
import { spawn } from 'child_process'

/** Returns whether an opener was launched. */
export function openInBrowser(file: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  let cmd: string
  let args: string[]
  if (platform === 'darwin') {
    cmd = 'open'
    args = [file]
  } else if (platform === 'win32') {
    // Explorer opens a file with its default handler and needs no shell quoting.
    cmd = 'explorer.exe'
    args = [file]
  } else {
    // Over SSH or in a container there is no display to open a browser on.
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false
    cmd = 'xdg-open'
    args = [file]
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => { /* no opener installed; the path was printed */ })
    child.unref()
    return true
  } catch {
    return false
  }
}
