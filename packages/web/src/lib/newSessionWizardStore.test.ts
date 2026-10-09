import { beforeEach, describe, expect, test } from 'bun:test'
import { onWizardOrphaned, claimOrphanWizard, clearWizard, orphanWizard, readWizardSnapshot, saveWizardSnapshot, type WizardSnapshot } from './newSessionWizardStore'

const snap: WizardSnapshot = {
  harnessId: 'claude', nativeProvider: '', cwd: '/work/x', task: 'T', subtaskTarget: null,
  model: 'opus', effort: 'high', prompt: 'hello', label: 'my title', attachments: [], step: 'review', dirty: true,
}

describe('new-session wizard store', () => {
  beforeEach(clearWizard)

  test('an unmount mid-wizard is adopted once, with every answer kept', () => {
    saveWizardSnapshot(snap)
    orphanWizard()
    expect(claimOrphanWizard()).toBe(true)
    expect(claimOrphanWizard()).toBe(false)
    expect(readWizardSnapshot()).toEqual(snap)
  })

  test('closing or starting forgets it', () => {
    saveWizardSnapshot(snap)
    clearWizard()
    orphanWizard()
    expect(claimOrphanWizard()).toBe(false)
    expect(readWizardSnapshot()).toBeNull()
  })

  test('nothing is orphaned without a snapshot', () => {
    orphanWizard()
    expect(claimOrphanWizard()).toBe(false)
  })

  test('a list already mounted is told when the wizard is orphaned', () => {
    let adopted = 0
    const off = onWizardOrphaned(() => { if (claimOrphanWizard()) adopted++ })
    saveWizardSnapshot(snap)
    orphanWizard()
    off()
    orphanWizard()
    expect(adopted).toBe(1)
  })
})
