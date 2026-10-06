import { expect, test } from 'bun:test'
import { gitCommandForPath } from './git'

test('uses native git for Windows drive paths', () => {
  expect(gitCommandForPath(String.raw`D:\code\repo`, 'win32')).toEqual({
    file: 'git',
    args: ['-C', String.raw`D:\code\repo`],
  })
})

test('uses WSL git for POSIX paths on Windows', () => {
  expect(gitCommandForPath('/mnt/d/code/repo', 'win32')).toEqual({
    file: 'wsl',
    args: ['git', '-C', '/mnt/d/code/repo'],
  })
})

test('normalizes Windows paths for a Linux server', () => {
  expect(gitCommandForPath(String.raw`D:\code\repo`, 'linux')).toEqual({
    file: 'git',
    args: ['-C', '/mnt/d/code/repo'],
  })
})
