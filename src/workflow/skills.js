'use strict';

const { WorkflowRuntimeError } = require('./runtime');

function validateSkillManifest(manifest = {}) {
  for (const key of ['id', 'version', 'name']) {
    if (!String(manifest[key] || '').trim()) throw new WorkflowRuntimeError('INVALID_SKILL', `Skill缺少${key}`);
  }
  if (!Array.isArray(manifest.permissions)) throw new WorkflowRuntimeError('INVALID_SKILL', 'Skill permissions必须是数组');
  return Object.freeze({ ...manifest, permissions: [...manifest.permissions] });
}

class SkillRegistry {
  constructor() { this.skills = new Map(); }

  register(manifest, handler) {
    const normalized = validateSkillManifest(manifest);
    if (typeof handler !== 'function') throw new WorkflowRuntimeError('INVALID_SKILL', 'Skill handler必须是函数');
    this.skills.set(normalized.id, { manifest: normalized, handler });
    return normalized;
  }

  async execute(skillId, input, context = {}) {
    const skill = this.skills.get(skillId);
    if (!skill) throw new WorkflowRuntimeError('SKILL_NOT_FOUND', `未安装Skill：${skillId}`);
    const result = await skill.handler({ ...input }, Object.freeze({ ...context, skill: skill.manifest }));
    if (!result || typeof result !== 'object') throw new WorkflowRuntimeError('INVALID_SKILL_RESULT', 'Skill必须返回对象结果');
    return { skill_id: skillId, skill_version: skill.manifest.version, ...result };
  }
}

class KnowledgeProvider {
  async search() { throw new WorkflowRuntimeError('KNOWLEDGE_NOT_CONFIGURED', '未配置知识库提供者'); }
}

module.exports = { KnowledgeProvider, SkillRegistry, validateSkillManifest };
