// npm run test:ui
// The component package entry must not reach the Tauri host, the bundled gallery, or the global JSX namespace.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const src = (path: string): string => new URL(`../../src/${path}`, import.meta.url).pathname

test('runTypes.ts exists and is free of Tauri imports', () => {
  assert.ok(existsSync(src('domain/runTypes.ts')))
  assert.ok(!readFileSync(src('domain/runTypes.ts'), 'utf8').includes('@tauri-apps'))
})

for (const file of ['components/PipelineView.tsx', 'domain/runInputs.ts', 'domain/wrapTool.ts', 'components/RunPanel.tsx', 'components/WorkflowDiagram.tsx', 'components/WorkflowLibrary.tsx', 'domain/graph.ts']) {
  test(`${file} has no host/gallery/global-JSX leaks`, () => {
    const text = readFileSync(src(file), 'utf8')
    for (const banned of ["from '../domain/host'", "from './host'", "from '../data/gallery'"]) {
      assert.ok(!text.includes(banned), `${file} contains ${banned}`)
    }
    assert.ok(!/(?<!React\.)JSX\.Element/.test(text), `${file} uses bare JSX.Element`)
  })
}
