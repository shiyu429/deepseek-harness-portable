import { delimiter } from 'node:path'
import { expect, it } from 'vitest'
import { desktopNodeEnvironment } from '../src/node-environment.ts'

it('keeps private Desktop launchers out of the Host environment inherited by PTC', () => {
  const environment = { PATH: '/user/bin', HOME: '/user' }
  expect(desktopNodeEnvironment('/desktop/electron', undefined, environment)).toEqual({
    ...environment, ELECTRON_RUN_AS_NODE: '1',
  })
  expect(environment).toEqual({ PATH: '/user/bin', HOME: '/user' })
})

it('provides private launchers only to package installation processes', () => {
  expect(desktopNodeEnvironment('/desktop/electron', '/desktop/bin', { PATH: '/user/bin' })).toEqual({
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DESKTOP_NODE_EXECUTABLE: '/desktop/electron',
    PATH: `/desktop/bin${delimiter}/user/bin`,
  })
})

it('keeps the shell host profile while restoring private profile paths for the backend', () => {
  const environment = { USERPROFILE: 'C:\\Users\\Host', APPDATA: 'C:\\Users\\Host\\AppData\\Roaming', DSH_PORTABLE_CHILD_PROFILE: JSON.stringify({ USERPROFILE: 'U:\\DSH\\data\\home', APPDATA: 'U:\\DSH\\data\\home\\AppData\\Roaming' }) }
  const child = desktopNodeEnvironment('/desktop/electron', undefined, environment)
  expect(child.USERPROFILE).toBe('U:\\DSH\\data\\home')
  expect(environment.USERPROFILE).toBe('C:\\Users\\Host')
})
