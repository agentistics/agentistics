import { describe, expect, test } from 'bun:test'
import { checkProjectName, defaultProjectParent, joinProjectPath, nameFromQuery } from './newProject'

describe('checkProjectName', () => {
  test('accepts ordinary names, accents and spaces included', () => {
    for (const n of ['meu-projeto', 'Meu Projeto', 'loja_2026', 'orçamento', 'v1.2']) expect(checkProjectName(n).ok).toBe(true)
  })
  test.each([
    ['', 'empty'], ['   ', 'empty'], ['a/b', 'separator'], ['..\\x', 'separator'], ['a:b', 'reserved-char'],
    ['what?', 'reserved-char'], ['.', 'dot-name'], ['..', 'dot-name'], [' app', 'edge-space-or-dot'],
    ['app.', 'edge-space-or-dot'], ['CON', 'windows-reserved'], ['lpt1.txt', 'windows-reserved'],
    ['x'.repeat(65), 'too-long'],
  ])('%p is refused as %p', (name, reason) => {
    expect(checkProjectName(name)).toEqual({ ok: false, reason: reason as never })
  })
})

describe('defaultProjectParent', () => {
  test('the folder holding most projects wins', () => {
    expect(defaultProjectParent('/home/u', ['/home/u/dev/a', '/home/u/dev/b', '/home/u/x/c'], true))
      .toEqual({ path: '/home/u/dev', exists: true })
  })
  test('projects directly in the home do not make the home the default', () => {
    expect(defaultProjectParent('/home/u', ['/home/u/a', '/home/u/b'], true)).toEqual({ path: '/home/u/projetos', exists: false })
  })
  test('a single stray project is not a habit', () => {
    expect(defaultProjectParent('/home/u', ['/home/u/dev/a'], false)).toEqual({ path: '/home/u/projects', exists: false })
  })
  test('outside the home never counts', () => {
    expect(defaultProjectParent('/home/u', ['/mnt/d/w/a', '/mnt/d/w/b'], true).path).toBe('/home/u/projetos')
  })
})

test('joinProjectPath keeps the parent separator', () => {
  expect(joinProjectPath('/home/u/dev/', 'x')).toBe('/home/u/dev/x')
  expect(joinProjectPath('C:\\Users\\u', 'x')).toBe('C:\\Users\\u\\x')
})

test('nameFromQuery offers plain names only', () => {
  expect(nameFromQuery(' loja ')).toBe('loja')
  expect(nameFromQuery('~/dev')).toBeNull()
  expect(nameFromQuery('/x')).toBeNull()
  expect(nameFromQuery('C:\\x')).toBeNull()
  expect(nameFromQuery('a?b')).toBeNull()
})
