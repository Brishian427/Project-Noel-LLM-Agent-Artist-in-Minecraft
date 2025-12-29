# Tripo API 测试指南

## 前置检查清单

### 1. 环境变量配置 ✓
- [x] `.env` 文件存在
- [x] `TRIPO_API_KEY` 已配置
- [x] `OPENAI_API_KEY` 已配置（用于 LLM）

### 2. Python 依赖安装
```bash
pip install -r requirements.txt
```
需要安装：
- trimesh >= 3.15.0
- numpy >= 1.24.0
- scipy >= 1.10.0

### 3. Node.js 依赖安装
```bash
npm install
```

### 4. 文件结构检查
确保以下文件存在：
- `generalised_agent.js` - 主 Agent 文件
- `voxelizer.py` - Python 体素化脚本
- `assets/` - 模型存储目录（会自动创建）

## 测试步骤

### 步骤 1: 启动 Minecraft 服务器
确保你的 Minecraft 服务器正在运行（localhost:25565）

### 步骤 2: 启动 Agent
```bash
node generalised_agent.js
```

你应该看到：
```
[INFO] Bot connecting to localhost:25565...
[INFO] Bot spawned!
[INFO] Setting up game mode and effects...
```

### 步骤 3: 在游戏中测试

#### 测试 1: 简单文本生成（推荐首次测试）
在 Minecraft 游戏中输入：
```
build a Christmas pony
```

或者：
```
imagine and build a snowman
```

#### 测试 2: 带分辨率的生成
```
build a reindeer with high detail
```

### 步骤 4: 观察调试输出

在控制台，你会看到详细的调试信息：

**成功流程示例：**
```
[TRIPO DEBUG] ========================================
[TRIPO DEBUG] Starting Tripo API call
[TRIPO DEBUG] Prompt: "a Christmas pony"
[TRIPO DEBUG] API Key: tsk_tNOnxN...xzN
[TRIPO DEBUG] ========================================
[TRIPO DEBUG] API Endpoint: https://api.tripo3d.ai/v1/text-to-3d
[TRIPO DEBUG] Request Body: { ... }
[TRIPO DEBUG] Response Status: 201
[TRIPO DEBUG] Tripo task created successfully: tsk_xxxxx
[TRIPO DEBUG] Polling attempt 1/36...
[TRIPO DEBUG] Current Status: "processing"
[TRIPO DEBUG] Polling attempt 2/36...
[TRIPO DEBUG] Current Status: "completed"
[TRIPO DEBUG] Model URL: https://...
[PIPELINE DEBUG] Step 1 SUCCESS: Model URL = https://...
[PIPELINE DEBUG] Step 2 SUCCESS: Model saved to assets/model_xxxxx.glb
[PIPELINE DEBUG] Step 3 SUCCESS: Location = (100, 64, 200)
[PIPELINE DEBUG] Step 4 SUCCESS: Built 1234 blocks
```

**错误流程示例：**
```
[TRIPO DEBUG] ========================================
[TRIPO DEBUG] EXCEPTION CAUGHT
[TRIPO DEBUG] Error Message: API error 401 Unauthorized
[TRIPO DEBUG] Error Stack: ...
[TRIPO DEBUG] ========================================
[TOOL DEBUG] imagine_and_build FAILED
[TOOL DEBUG] Error Message: ...
```

### 步骤 5: 检查生成的文件

成功生成后，检查以下位置：
- `assets/model_<timestamp>.glb` - 下载的 3D 模型
- `assets/temp_blueprint.json` - 体素化后的蓝图数据

## 常见问题排查

### 问题 1: "ModuleNotFoundError: No module named 'trimesh'"
**解决方案：**
```bash
pip install trimesh numpy scipy
```

### 问题 2: "API error 401 Unauthorized"
**可能原因：**
- API Key 无效或过期
- API Key 格式错误

**解决方案：**
1. 检查 `.env` 文件中的 `TRIPO_API_KEY`
2. 确认 API Key 以 `tsk_` 开头
3. 在 Tripo 官网验证 API Key 是否有效

### 问题 3: "Python execution failed"
**可能原因：**
- Python 路径问题
- Python 脚本权限问题

**解决方案：**
1. 确认 `python` 或 `python3` 在 PATH 中
2. 检查 `voxelizer.py` 文件是否存在
3. 尝试手动运行：`python voxelizer.py test.obj output.json 20`

### 问题 4: "Model generation timeout"
**可能原因：**
- API 响应慢
- 网络问题

**解决方案：**
- 检查网络连接
- 查看 Tripo API 状态
- 尝试更简单的 prompt

### 问题 5: "No model URL found"
**可能原因：**
- API 响应格式与预期不符
- 任务状态字段名称不同

**解决方案：**
- 查看 `[TRIPO DEBUG]` 日志中的完整响应
- 检查响应中的字段名称
- 可能需要调整代码以匹配实际 API 格式

## 调试技巧

1. **查看完整日志**：所有调试信息都以 `[TRIPO DEBUG]` 或 `[PIPELINE DEBUG]` 开头
2. **检查 API 响应**：日志中会显示完整的 API 请求和响应
3. **分步测试**：如果完整流程失败，可以单独测试：
   - 只测试 API 调用（不下载）
   - 只测试 Python 脚本（手动运行）
   - 只测试下载（使用已知 URL）

## 下一步

如果测试成功，你可以：
1. 尝试不同的 prompt（"Christmas tree", "gift box", "snowman" 等）
2. 调整分辨率参数（默认 20，可以尝试 15-30）
3. 查看生成的模型文件，确认质量

如果测试失败：
1. 复制完整的错误日志
2. 检查上述常见问题
3. 根据错误信息调整代码或配置

