# Photorealistic Persona Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every newly triggered persona image task asks 小云雀 for a real-camera photograph of an adult woman and explicitly rejects 2D and CG styles.

**Architecture:** Extract the existing inline persona image message into a pure `buildPersonaImagePrompt` function. `processPersona` passes the Kimi persona text and the Base “输入人设要求” value into that function while leaving submission, polling, image download, attachment replacement, and Base write-back unchanged.

**Tech Stack:** Node.js CommonJS, `node:test`, 小云雀 API, lark-cli.

## Global Constraints

- Output must look like a real-camera photograph of a real adult woman.
- Preserve the Kimi persona, innocent temperament, age 20–30, and user-specified clothing.
- Require natural skin texture, realistic facial proportions, and natural anatomy.
- Reject 2D, anime, illustration, cartoon, 二次元, painting, 3D CG, game-model, digital-human, plastic-skin, and obvious rendered styles.
- Keep a single full-body subject and no other people.
- Do not add post-generation classification, automatic regeneration, a fixed reference face, or a new provider.

---

### Task 1: Build and Use the Photorealistic Persona Prompt

**Files:**
- Modify: `test/worker.test.js`
- Modify: `src/worker.js`

**Interfaces:**
- Consumes: `buildPersonaImagePrompt(persona: string, userRequirement?: string)`
- Produces: a complete 小云雀 image-generation task message string.

- [x] **Step 1: Write the failing prompt test**

```js
test('persona image prompt requires real-camera photography and rejects 2D and CG styles', () => {
  const prompt = buildPersonaImagePrompt('传承咏春的武术少女', '穿青白中式长裙');
  assert.match(prompt, /传承咏春的武术少女/);
  assert.match(prompt, /穿青白中式长裙/);
  assert.match(prompt, /真实相机拍摄/);
  assert.match(prompt, /自然皮肤纹理/);
  assert.match(prompt, /真实五官比例/);
  assert.match(prompt, /禁止.*2D.*动漫.*插画.*3D CG.*游戏建模.*数字人/);
  assert.match(prompt, /20至30岁/);
  assert.match(prompt, /单人全身/);
  assert.match(prompt, /不得出现其他人物/);
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `node --test test/worker.test.js`

Expected: FAIL because `buildPersonaImagePrompt` is not exported/defined.

- [x] **Step 3: Implement the minimal prompt builder**

```js
function buildPersonaImagePrompt(persona, userRequirement = '') {
  return [
    `根据以下人设生成单人全身人物形象照片：${persona}`,
    `用户要求：${userRequirement}`,
    '输出必须是真实相机拍摄的真人摄影效果：真实成年女性，自然皮肤纹理、真实五官比例、自然人体结构和真实光影，不得呈现渲染质感。',
    '人物必须是20至30岁的成年清纯女生，严格保持用户指定服装；画面为单人全身照片，不得出现其他人物。',
    '禁止生成2D、动漫、插画、卡通、二次元、绘画、3D CG、游戏建模、数字人、塑料皮肤或明显渲染风格。',
    '直接生成最终图片。',
  ].filter(Boolean).join('\n');
}
```

- [x] **Step 4: Integrate the builder and export it**

Replace the inline prompt in `processPersona` with:

```js
const imagePrompt = buildPersonaImagePrompt(persona, row['输入人设要求'] || '');
```

Add `buildPersonaImagePrompt` to `module.exports`.

- [x] **Step 5: Run full verification**

Run: `npm test`

Expected: 10 tests PASS, 0 tests FAIL.

Run: `node --check src/worker.js`

Expected: exit code 0.

Run: `git diff --check`

Expected: exit code 0 with no whitespace errors.

- [x] **Step 6: Commit**

```bash
git add src/worker.js test/worker.test.js docs/superpowers/plans/2026-07-15-photorealistic-persona-image.md
git commit -m "feat: require photorealistic persona images"
```
