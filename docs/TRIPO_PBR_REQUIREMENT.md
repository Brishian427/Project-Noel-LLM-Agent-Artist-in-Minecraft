# Tripo API PBR 模型要求与错误反馈

## ✅ 错误反馈机制

### 1. 强制 PBR 检查（已实施）

**位置**：`generalised_agent.js` 第 2497-2527 行

**行为**：
- 如果 `TRIPO_CONFIG.requirePBR = true` 且 PBR 模型不可用
- **立即抛出错误**，阻止继续下载无颜色模型
- **显示详细的错误信息**，包括：
  - 为什么需要 PBR 模型
  - 可用的模型类型
  - 建议的解决方案

**错误输出示例**：
```
[TRIPO DEBUG] ========================================
[TRIPO DEBUG] ❌ PBR MODEL REQUIRED BUT NOT AVAILABLE
[TRIPO DEBUG] PBR model is REQUIRED for color support, but Tripo API did not return pbr_model.
[TRIPO DEBUG] Available models: base_model, model
[TRIPO DEBUG] This indicates that your Tripo API plan may not support PBR texture generation,
[TRIPO DEBUG] or the model was generated without textures.
[TRIPO DEBUG] To avoid wasting API calls on models without colors, this request is being rejected.
[TRIPO DEBUG] Please check your Tripo API plan or contact Tripo support to enable PBR texture generation.
[TRIPO DEBUG] Output Fields:
  pbr_model: NOT AVAILABLE
  base_model: <URL>
  model: <URL>
[TRIPO DEBUG] Full Response: {...}
[TRIPO DEBUG] ========================================
```

**游戏内反馈**：
- Agent 会在聊天中显示：`⚠️ I couldn't get a colored model from Tripo AI...`
- 然后抛出错误，阻止继续

### 2. 配置选项

**位置**：`generalised_agent.js` 第 32-34 行

```javascript
const TRIPO_CONFIG = {
    requirePBR: true,      // 强制要求 PBR 模型
    allowFallback: false   // 不允许回退（避免浪费）
};
```

**选项说明**：
- `requirePBR: true` + `allowFallback: false` = **严格模式**（推荐）
  - 如果没有 PBR 模型，立即失败
  - 避免浪费 API 调用
- `requirePBR: true` + `allowFallback: true` = **警告模式**
  - 如果没有 PBR 模型，显示警告但继续
  - 用于调试或测试

## 🎯 如何明确要求 Tripo 生成带颜色的模型

### 1. Prompt 增强（已实施）

**位置**：`generalised_agent.js` 第 2132-2138 行

**当前实现**：
```javascript
const enhancedPrompt = `${prompt}, colorful, vibrant colors, detailed textures, high quality materials, PBR textures, textured model`;
negative_prompt: 'low quality, blurry, distorted, monochrome, grayscale, untextured, no texture, wireframe, uncolored'
```

**效果**：
- ✅ 在 prompt 中明确要求颜色、纹理、PBR 材质
- ✅ 在 negative_prompt 中排除无颜色、无纹理的模型

### 2. API 请求参数（当前限制）

**当前请求体**：
```javascript
{
    type: 'text_to_model',
    prompt: enhancedPrompt,
    negative_prompt: '...'
}
```

**可能的额外参数**（需要 Tripo API 文档确认）：
- `style`: 可能的值如 `"realistic"`, `"stylized"`, `"pbr"` 等
- `quality`: 可能的值如 `"high"`, `"medium"`, `"low"` 等
- `texture_enabled`: 布尔值，明确启用纹理生成
- `mode`: 可能的值如 `"one_click"`（一键生成，带纹理）vs `"build_refine"`（构建与精修）

**注意**：根据搜索结果，Tripo API 可能不公开这些参数，主要依赖 prompt 来指定需求。

### 3. 建议的改进方案

如果 Tripo API 支持额外参数，可以这样修改：

```javascript
const requestBody = {
    type: 'text_to_model',
    prompt: enhancedPrompt,
    negative_prompt: '...',
    // 如果 API 支持，添加以下参数：
    // style: 'realistic',           // 要求真实感（通常包含颜色）
    // quality: 'high',              // 高质量（可能包含更多纹理细节）
    // texture_enabled: true,       // 明确启用纹理
    // mode: 'one_click'            // 一键生成模式（自动包含 PBR 纹理）
};
```

## 📋 完整流程

### 步骤 1: API 请求
- ✅ Prompt 增强（要求颜色和 PBR 纹理）
- ✅ Negative prompt（排除无颜色模型）
- ⏳ 可能的额外参数（需要 API 文档确认）

### 步骤 2: API 响应检查
- ✅ 检查 `output.pbr_model` 是否存在
- ✅ 如果不存在，立即失败并显示错误
- ✅ 显示所有可用的模型类型

### 步骤 3: 错误反馈
- ✅ 控制台详细错误日志
- ✅ 游戏内用户友好的消息
- ✅ 明确的解决方案建议

## 🔍 调试建议

### 如果 PBR 模型不可用：

1. **检查 API 响应**：
   ```
   [TRIPO DEBUG] Output Fields Check:
     output.pbr_model: undefined  ← 问题在这里
   ```

2. **可能的原因**：
   - Tripo API 计划不支持 PBR 纹理生成
   - API 版本问题
   - Prompt 不够明确（虽然已增强）

3. **解决方案**：
   - 检查 Tripo 账户设置，确认 API 计划是否支持 PBR
   - 联系 Tripo 支持，询问如何启用 PBR 纹理生成
   - 查看 Tripo API 文档，确认是否有额外的请求参数

## 📝 当前状态

- [x] 强制 PBR 检查已实施
- [x] 错误反馈机制已完善
- [x] Prompt 增强已实施
- [x] 游戏内用户反馈已添加
- [ ] **需要确认**：Tripo API 是否支持额外的请求参数来强制生成 PBR 模型

---

**最后更新**：2024-12-19
**状态**：错误反馈机制已完善，等待实际测试验证

