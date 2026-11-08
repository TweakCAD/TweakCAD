/**
 * Editing the knob's Extrude 1, whose one profile is lost, on the real
 * kernel: the sketch its direction names (Sketch 2, hidden) is drawn and
 * takes region clicks while the panel is open, nothing is written to the
 * document, and closing the panel hides it again.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { make_gcs_wrapper } from '@salusoft89/planegcs';
import { OcctKernel } from 'occt-wasm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seededIds, type Json } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { bootApp, type AppServiceClient, type AppServices } from '../services';
import { MemoryWorkingCopy } from '../storage/workingCopy';
import { ModelScene } from '../viewport/ModelScene';
import { sceneMode } from '../viewport/ViewportView';
import { readExtrude } from './extrude';
import { isMissingProfile, regionKeysAt, sketchesOf } from './profiles';
import { profileSketches, showSketches } from './profileSketches';

const HERE = dirname(fileURLToPath(import.meta.url));

let k: OcctKernel;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(HERE, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  service = new EvaluationService(k, await make_gcs_wrapper(realpathSync(wasm)));
}, 60_000);

afterAll(() => {
  service.release();
  k.releaseAll();
});

function client(s: EvaluationService): AppServiceClient {
  return {
    init: () => Promise.resolve({ loadTimeMs: 0 }),
    evaluate: (doc) => Promise.resolve(s.evaluate(doc as Json)),
    pick: (target, options) => Promise.resolve(s.pick(target, options)),
    exportFile: (format, scope, options) => Promise.resolve(s.exportFile(format, scope, options)),
    properties: (key) => Promise.resolve(s.properties(key)),
    externalCurves: (key, mode, frame) => Promise.resolve(s.externalCurves(key, mode, frame)),
    measure: (kind, targets) => Promise.resolve(s.measure(kind, targets)),
    resolve: (record, scope) => Promise.resolve(s.resolve(record, scope)),
    bodiesBefore: (scope, records, options) => Promise.resolve(s.bodiesBefore(scope, records, options)),
  };
}

async function settled(s: AppServices): Promise<Display> {
  do await s.scheduler.whenIdle();
  while (s.scheduler.busy);
  const display = s.display.getState().display;
  if (!display) throw new Error('nothing shown');
  return display;
}

const featureNamed = (part: Json, name: string): string =>
  ((part.timeline as Json[]).find((f) => f.name === name) as Json).id as string;

describe('the sketch a profile panel shows', { timeout: 120_000 }, () => {
  it('shows the hidden sketch an extrude with a lost profile names, writes nothing, and hides it on close', async () => {
    const { services: s } = await bootApp({
      client: client(service),
      workingCopy: new MemoryWorkingCopy(),
      localId: null,
      ids: seededIds(41),
      name: () => 'knob',
    });
    expect(s.session.openText(readFileSync(resolvePath(HERE, 'fixtures/knob.cadjson'), 'utf8')).ok).toBe(true);
    const display = await settled(s);
    const doc = s.editor.document;
    const partRow = (doc.parts as Json[])[0] as Json;
    const part = partRow.id as string;
    const extrude = featureNamed(partRow, 'Extrude 1');
    const sketch = featureNamed(partRow, 'Sketch 2');
    expect(sketchesOf(display, part).find((d) => d.feature === sketch)?.visible).toBe(false);

    const scene = new ModelScene();
    scene.setDisplay(display, { part });
    scene.setMode(sceneMode(s.app.getState()));
    const drawn = scene.root.getObjectByName(`sketch ${sketch}`);
    if (!drawn) throw new Error('Sketch 2 is not in the scene');
    // Off the centre point, inside the D of the shaft hole (sketch x is world x, sketch y is world -z).
    const [shaft] = regionKeysAt(display, part, sketch, [[-1.3, 0.7]]);
    if (shaft === undefined) throw new Error('no region near the centre of Sketch 2');
    // From below, up through the knob's bottom face, where Sketch 2 lies.
    const up = () =>
      scene.pick(new THREE.Raycaster(new THREE.Vector3(-1.3, -100, -0.7), new THREE.Vector3(0, 1, 0)), 0.01);
    expect(drawn.visible).toBe(false);
    expect(up()).not.toEqual({ key: shaft });

    // The panel opens on Extrude 1: its one profile is lost, and its direction names Sketch 2.
    let changes = 0;
    const off = s.editor.store.subscribe(() => changes++);
    const read = readExtrude(doc, part, extrude);
    if (!read) throw new Error('Extrude 1 does not read back');
    expect(read.profiles.every(isMissingProfile)).toBe(true);
    const shown = profileSketches(s.editor.document, part, {
      profiles: read.profiles,
      references: [read.inputs.direction],
    });
    expect(shown).toEqual([sketch]);
    const close = showSketches(s.app, shown);
    scene.setMode(sceneMode(s.app.getState()));
    expect(drawn.visible).toBe(true);
    expect(up()).toEqual({ key: shaft });

    // Nothing is written: the document, its visibility attributes and the undo history stay as they were.
    await settled(s);
    expect(changes).toBe(0);
    expect(s.editor.document).toBe(doc);
    expect(sketchesOf(s.display.getState().display, part).find((d) => d.feature === sketch)?.visible).toBe(false);

    // Closing the panel restores the sketch's own visibility.
    close();
    scene.setMode(sceneMode(s.app.getState()));
    expect(s.app.getState().shownSketches).toEqual([]);
    expect(drawn.visible).toBe(false);
    expect(up()).not.toEqual({ key: shaft });
    off();
  });
});
