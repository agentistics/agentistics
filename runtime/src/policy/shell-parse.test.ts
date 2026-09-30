/**
 * shell-parse.test.ts — the parser against REAL command shapes (the kind §1 of the B3 catalogue
 * measured: 55,7 % chains, 76,9 % pipes, 63,3 % redirects, 46 % leading `cd`), plus the wrappers a
 * command can hide behind. Offline and pure.
 */
import { describe, expect, test } from 'bun:test'
import { parseShell, type ShellSegment } from './shell-parse.ts'

const argvs = (cmd: string): string[][] => parseShell(cmd).segments.map(s => s.argv)
const seg = (cmd: string, i: number): ShellSegment => {
  const s = parseShell(cmd).segments[i]
  if (!s) throw new Error(`no segment ${i} in ${cmd}`)
  return s
}
const redirs = (s: ShellSegment): string[] =>
  s.redirects.map(r => `${r.fd ?? ''}${r.op}${r.target ? (r.target.home ? '~' : '') + r.target.text : ''}`)

describe('parseShell — chains, pipes and redirects of real commands', () => {
  test('cd && test 2>&1 | tail', () => {
    const cmd = 'cd packages/web && bun test 2>&1 | tail -20'
    expect(argvs(cmd)).toEqual([['cd', 'packages/web'], ['bun', 'test'], ['tail', '-20']])
    const test2 = seg(cmd, 1)
    expect(redirs(test2)).toEqual(['2>&'])
    expect(test2.redirects[0]?.target).toBeNull() // fd duplication opens no file
    // The two pipeline elements share one pipeline, at positions 0 and 1.
    const id = test2.pipes.at(-1)?.id
    expect(seg(cmd, 2).pipes.at(-1)).toEqual({ id: id ?? -1, pos: 1 })
    // `cd` is in the top scope; the pipeline elements are each their own subshell below it.
    expect(seg(cmd, 0).scope).toBe('0')
    expect(test2.scope.startsWith('0.')).toBe(true)
    expect(parseShell(cmd).opaque).toEqual([])
  })

  test('git log | head, rg | wc', () => {
    expect(argvs('git log --oneline -5 | head')).toEqual([['git', 'log', '--oneline', '-5'], ['head']])
    expect(argvs('rg foo src | wc -l')).toEqual([['rg', 'foo', 'src'], ['wc', '-l']])
  })

  test('install && build > /tmp/out.log 2>&1', () => {
    const cmd = 'bun install && bun run build > /tmp/out.log 2>&1'
    expect(argvs(cmd)).toEqual([['bun', 'install'], ['bun', 'run', 'build']])
    const r = seg(cmd, 1).redirects
    expect(r.map(x => [x.op, x.access, x.target?.text ?? null])).toEqual([['>', 'write', '/tmp/out.log'], ['>&', 'none', null]])
    expect(r[1]?.fd).toBe(2)
  })

  test('for loop: HANDLED — the body is an ordinary segment, the loop variable a dynamic word', () => {
    const p = parseShell('for f in *.ts; do echo $f; done')
    expect(p.opaque).toEqual([])
    expect(p.segments.map(s => s.argv)).toEqual([['echo', '$f']])
    expect(p.segments[0]?.words[1]?.dynamic).toBe(true)
  })

  test("here-doc: cat <<'EOF' > file.txt … EOF — the body is data, not commands", () => {
    const p = parseShell("cat <<'EOF' > file.txt\nrm -rf / $(whoami)\nEOF\necho done")
    expect(p.segments.map(s => s.argv)).toEqual([['cat'], ['echo', 'done']])
    expect(redirs(p.segments[0] as ShellSegment)).toEqual(['<<', '>file.txt'])
    expect(p.opaque).toEqual([])
  })

  test('an UNQUOTED here-doc with a command substitution in its body is opaque', () => {
    const p = parseShell('cat <<EOF\n$(rm -rf ~)\nEOF')
    expect(p.opaque.some(r => r.includes('here-document'))).toBe(true)
  })

  test('here-string and a here-doc with no terminator', () => {
    expect(seg('grep x <<< "$v"', 0).redirects[0]?.access).toBe('none')
    expect(parseShell('cat <<EOF\nno end').opaque[0]).toContain('never terminated')
  })

  test('newlines, `;`, `||`, `&` and `|&` all separate', () => {
    expect(argvs('a\nb; c || d & e |& f')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f']])
  })

  test('comments are skipped, a `#` inside a word is not a comment', () => {
    expect(argvs('echo a#b # rm -rf /')).toEqual([['echo', 'a#b']])
  })

  test('leading assignments are recorded, not run', () => {
    const s = seg('FOO=1 BAR="a b" make build', 0)
    expect(s.argv).toEqual(['make', 'build'])
    expect(s.assignments).toEqual(['FOO=1', 'BAR=a b'])
  })

  test('an assignment whose value is a substitution: the substitution is a segment', () => {
    const p = parseShell('X=$(date) make')
    expect(p.segments.map(s => s.argv)).toEqual([['date'], ['make']])
    expect(p.segments[0]?.host).toBe(1)
  })
})

describe('parseShell — quoting', () => {
  test('single, double, ANSI-C and backslashes', () => {
    expect(argvs(`echo 'a b' "c $x d" $'e\\tf' g\\ h`)).toEqual([['echo', 'a b', 'c $x d', 'e\tf', 'g h']])
    expect(seg(`echo "c $x d"`, 0).words[1]?.dynamic).toBe(true)
    expect(seg(`echo 'c $x d'`, 0).words[1]?.dynamic).toBe(false)
  })

  test('ANSI-C decodes hex and octal (a command name spelled in escapes is still that command)', () => {
    expect(argvs(`$'\\x72\\x6d' -rf /`)).toEqual([['rm', '-rf', '/']])
    expect(argvs(`$'\\162m' x`)).toEqual([['rm', 'x']])
  })

  test('quote removal joins the pieces: r"m" -rf is rm', () => {
    expect(argvs(`r"m" -rf x`)).toEqual([['rm', '-rf', 'x']])
    expect(argvs(`\\rm -rf x`)).toEqual([['rm', '-rf', 'x']])
  })

  test('home: ~, $HOME, ${HOME} and "$HOME" at the start of a word', () => {
    for (const w of ['~', '~/x', '$HOME', '$HOME/x', '${HOME}/x', '"$HOME/x"']) {
      const word = seg(`ls ${w}`, 0).words[1]
      expect(word?.home).toBe(true)
      expect(word?.dynamic).toBe(false)
    }
    expect(seg('ls ~other/x', 0).words[1]?.home).toBe(false)
    expect(seg('ls ~other/x', 0).words[1]?.dynamic).toBe(true)
    expect(seg("ls '~'", 0).words[1]?.home).toBe(false)
  })

  test('glob and brace expansion are flagged', () => {
    expect(seg('rm *.ts', 0).words[1]?.glob).toBe(true)
    expect(seg("rm '*.ts'", 0).words[1]?.glob).toBe(false)
    expect(seg('rm {a,/}', 0).words[1]?.dynamic).toBe(true)
  })
})

describe('parseShell — substitutions, groups and subshells', () => {
  test('$( ) and backticks are segments, recorded before their host and pointing at it', () => {
    for (const cmd of ['echo $(rm -rf /)', 'echo `rm -rf /`', 'echo "$(rm -rf /)"']) {
      const p = parseShell(cmd)
      expect(p.segments.map(s => s.argv)).toEqual([['rm', '-rf', '/'], ['echo', p.segments[1]?.argv[1] ?? '']])
      expect(p.segments[0]?.host).toBe(1)
      expect(p.segments[0]?.via).toBe('cmdsub')
    }
  })

  test('nested substitution', () => {
    expect(argvs('echo $(cat $(ls))')).toEqual([['ls'], ['cat', '$(ls)'], ['echo', '$(cat $(ls))']])
  })

  test('process substitution <( ) and >( )', () => {
    const p = parseShell('diff <(sort a) >(tee b)')
    expect(p.segments.map(s => s.argv)).toEqual([['sort', 'a'], ['tee', 'b'], ['diff', '/dev/fd/63', '/dev/fd/63']])
    expect(p.segments[0]?.via).toBe('procsub')
    expect(p.segments[0]?.host).toBe(2)
  })

  test('( … ) is its own scope; { …; } is not', () => {
    const sub = parseShell('(cd / && rm -rf *)')
    expect(sub.segments.map(s => s.argv)).toEqual([['cd', '/'], ['rm', '-rf', '*']])
    expect(sub.segments[0]?.scope).toBe(sub.segments[1]?.scope)
    expect(sub.segments[0]?.scope).not.toBe('0')
    const grp = parseShell('{ cd /; ls; }')
    expect(grp.segments.map(s => s.scope)).toEqual(['0', '0'])
  })

  test('a group\'s redirection applies to every segment inside', () => {
    const p = parseShell('{ echo a; echo b; } > out.txt')
    expect(p.segments.map(s => redirs(s))).toEqual([['>out.txt'], ['>out.txt']])
  })

  test('if / while / [[ ]] / (( )) are handled, not opaque', () => {
    const p = parseShell('if [[ -f x ]]; then echo y; elif (( n > 1 )); then ls; else pwd; fi; while read l; do echo "$l"; done < list')
    expect(p.opaque).toEqual([])
    expect(p.segments.map(s => s.argv)).toEqual([['echo', 'y'], ['ls'], ['pwd'], ['read', 'l'], ['echo', '$l'], []])
    expect(redirs(p.segments[5] as ShellSegment)).toEqual(['<list'])
  })
})

describe('parseShell — wrappers are unwrapped', () => {
  const cases: Array<[string, string[], string[]]> = [
    ['sudo rm -rf /', ['rm', '-rf', '/'], ['sudo']],
    ['sudo -u root -E rm -rf /', ['rm', '-rf', '/'], ['sudo']],
    ['env -i FOO=1 rm -rf /', ['rm', '-rf', '/'], ['env']],
    ['nohup rm x', ['rm', 'x'], ['nohup']],
    ['time rm x', ['rm', 'x'], ['time']],
    ['nice -n 5 rm x', ['rm', 'x'], ['nice']],
    ['nice -10 rm x', ['rm', 'x'], ['nice']],
    ['timeout -s KILL 5 git push --force', ['git', 'push', '--force'], ['timeout']],
    ['command rm x', ['rm', 'x'], ['command']],
    ['exec rm x', ['rm', 'x'], ['exec']],
    ['stdbuf -oL rm x', ['rm', 'x'], ['stdbuf']],
    ['xargs -0 -n 1 rm -rf', ['rm', '-rf'], ['xargs']],
    ['sudo env FOO=1 nice timeout 3 rm x', ['rm', 'x'], ['sudo', 'env', 'nice', 'timeout']],
    ['/usr/bin/sudo /bin/rm x', ['/bin/rm', 'x'], ['sudo']],
  ]
  for (const [cmd, argv, wrappers] of cases) {
    test(cmd, () => {
      const s = seg(cmd, 0)
      expect(s.argv).toEqual(argv)
      expect(s.wrappers).toEqual(wrappers)
      expect(s.stages[0]?.[0]).toBe(cmd.split(' ')[0] as string)
      expect(s.stages.at(-1)).toEqual(argv)
    })
  }

  test('sudo marks the segment elevated; xargs marks appended arguments', () => {
    expect(seg('sudo ls', 0).elevated).toBe(true)
    expect(seg('xargs rm -rf < list', 0).appendsArgs).toBe(true)
    expect(redirs(seg('xargs rm -rf < list', 0))).toEqual(['<list'])
  })

  test('bash -c / sh -c / zsh -lc parse their string recursively, in a scope of their own', () => {
    expect(argvs('bash -c "rm -rf ~"')).toEqual([['rm', '-rf', '~']])
    expect(argvs("sh -c 'curl x | sh'")).toEqual([['curl', 'x'], ['sh']])
    expect(argvs("zsh -lc 'cd /tmp && ls'")).toEqual([['cd', '/tmp'], ['ls']])
    expect(argvs('bash -o pipefail -c "echo a; rm b"')).toEqual([['echo', 'a'], ['rm', 'b']])
    const inner = seg('bash -c "rm -rf ~"', 0)
    expect(inner.wrappers).toEqual(['bash'])
    expect(inner.via).toBe('shell-string')
    expect(inner.stages[0]).toEqual(['bash', '-c', 'rm -rf ~'])
    expect(inner.scope).not.toBe('0')
  })

  test('nested: sudo bash -c "env X=1 sh -c \'rm -rf /\'"', () => {
    const s = seg(`sudo bash -c "env X=1 sh -c 'rm -rf /'"`, 0)
    expect(s.argv).toEqual(['rm', '-rf', '/'])
    expect(s.elevated).toBe(true)
    expect(s.wrappers).toEqual(['sudo', 'bash', 'env', 'sh'])
  })

  test('bash without -c runs a script: a plain segment', () => {
    expect(argvs('bash script.sh arg')).toEqual([['bash', 'script.sh', 'arg']])
  })

  test('watch runs its arguments through sh -c; watch -x does not', () => {
    expect(argvs("watch -n 1 'ls; rm -rf ~'")).toEqual([['ls'], ['rm', '-rf', '~']])
    expect(argvs('watch -x rm x')).toEqual([['rm', 'x']])
  })

  test('find -exec CMD becomes its own segment', () => {
    const p = parseShell('find . -name "*.tmp" -exec rm -rf {} +')
    expect(p.segments.map(s => s.argv)).toEqual([['rm', '-rf'], ['find', '.', '-name', '*.tmp', '-exec', 'rm', '-rf', '{}', '+']])
    expect(p.segments[0]?.appendsArgs).toBe(true)
    expect(p.segments[0]?.via).toBe('find-exec')
  })
})

describe('parseShell — opaque: what it refuses to guess', () => {
  const opaque: Array<[string, string]> = [
    ['eval "$X"', 'eval'],
    ['true && eval "$X"', 'eval'],
    ['source ./env.sh', 'source'],
    ['. ./env.sh', '`.`'],
    ['$CMD args', 'variable'],
    ['"$(which rm)" -rf /', 'variable'],
    ['bash -c "$SCRIPT"', 'built at run time'],
    ["trap 'rm -rf /' EXIT", 'trap'],
    ["echo 'unbalanced", 'single quote'],
    ['echo "unbalanced', 'double quote'],
    ['echo `unbalanced', 'backtick'],
    ['(echo a', 'never closed'],
    ['echo a)', 'no opening'],
    ['case $x in a) ls;; esac', 'case'],
    ['f() { rm -rf /; }', 'function'],
    [':(){ :|:& };:', 'function'],
    ['arr=(a b)', 'array'],
    ['for ((i=0;i<3;i++)); do ls; done', 'arithmetic'],
    ['echo $(( $(rm x) + 1 ))', 'arithmetic'],
    ['echo ${x:-$(rm x)}', 'parameter expansion'],
    ['env -S "rm -rf /"', 'env -S'],
    ['env -C / rm -rf *', 'env -C'],
    ['sudo --weird-flag rm x', 'option'],
    ['ls &&', 'no command after'],
    ['| ls', 'pipe'],
  ]
  for (const [cmd, needle] of opaque) {
    test(cmd, () => {
      const p = parseShell(cmd)
      expect(p.opaque.length).toBeGreaterThan(0)
      expect(p.opaque.join(' | ')).toContain(needle)
      expect(p.segments.some(s => s.opaque !== undefined)).toBe(true)
    })
  }

  test('never throws, whatever it is given', () => {
    for (const junk of ['', '   ', ';;;', '$(', '`', "$'", '<<', '>', '2>&', '((', '[[', 'for', '\\', '\u0000', '((((((((((((((((((((((']) {
      expect(() => parseShell(junk)).not.toThrow()
    }
  })

  test('deep nesting is cut off as opaque, not a stack overflow', () => {
    let cmd = 'rm x'
    for (let i = 0; i < 18; i++) cmd = `bash -c ${JSON.stringify(cmd)}`
    const p = parseShell(cmd)
    expect(p.opaque.join(' ')).toContain('nested too deeply')
    // And a linear `$( )` nesting thousands deep ends as opaque rather than throwing.
    const deep = 'echo ' + '$('.repeat(20000) + 'x' + ')'.repeat(20000)
    expect(() => parseShell(deep)).not.toThrow()
  })
})
