# 颜色信息流程检查

## 🔍 完整流程检查

### 1. Tripo API 调用 → 模型下载
**位置**：`generalised_agent.js` 第 2410-2442 行

**检查点**：
- ✅ 优先使用 `pbr_model`（包含颜色信息）
- ✅ 如果 PBR 不可用，回退到 `base_model`，最后才是 `model`
- ✅ 日志显示选择的模型类型

**调试输出**：
```
[TRIPO DEBUG] Output Fields Check:
  output.pbr_model: <URL or undefined>
  output.base_model: <URL or undefined>
  output.model: <URL>
[TRIPO DEBUG] Selected Model Type: pbr_model (with colors/textures)
```

### 2. 模型下载 → voxelizer.py 处理
**位置**：`generalised_agent.js` 第 1672-1760 行

**检查点**：
- ✅ 调用 `python voxelizer.py <model_file> <output.json> <resolution>`
- ✅ Python 脚本处理 GLB 文件并提取颜色

**调试输出**：
```
[SKILLS] Executing: python "voxelizer.py" "assets/model_xxx.glb" "assets/temp_blueprint.json" 20
[VOXELIZER] Extracting colours from mesh...
[VOXELIZER] Vertex colours: False, Face colours: False, Material: True
[VOXELIZER] Unique RGB colours found: X
```

### 3. voxelizer.py 颜色提取
**位置**：`voxelizer.py` 第 71-220 行

**检查点**：
- ✅ 检查 vertex colors、face colors、material colors
- ✅ 尝试多种 material 属性（`main_color`, `diffuse`, `baseColorFactor`, `properties`）
- ✅ RGB 值正常化（0-255 范围）
- ✅ 颜色映射到 Minecraft blocks

**调试输出**：
```
[VOXELIZER] Colour extraction complete
[VOXELIZER] Unique RGB colours found: X
[VOXELIZER] Block mapping complete. Unique blocks: X
[VOXELIZER] Block distribution: {...}
```

### 4. JSON 读取 → Blueprint 转换
**位置**：`generalised_agent.js` 第 1767-1810 行

**检查点**：
- ✅ 读取 JSON 文件
- ✅ 检查每个 entry 的 `block` 字段
- ✅ 验证颜色多样性

**新增调试输出**：
```
[SKILLS] Sample entry from JSON: {...}
[SKILLS] Color check (first 100 entries):
  - Unique RGB colors: X
  - Unique blocks: X
  ✓ Multiple colors found: ...
  ✓ Multiple block types: ...
```

### 5. Blueprint → 构建
**位置**：`generalised_agent.js` 第 1349-1520 行

**检查点**：
- ✅ `buildStructure` 接收 blueprint（包含 `block` 字段）
- ✅ 每个 entry 的 `block` 字段被正确使用
- ✅ `/setblock` 命令使用正确的 block 名称

**新增调试输出**：
```
[SKILLS] Block color distribution (from voxelizer.py): {...}
[SKILLS] ✓ Color mapping successful: X unique block types
[SKILLS] Placing block 1/100: minecraft:red_wool at (x, y, z)
[SKILLS]   RGB: (255, 0, 0) → Block: red_wool
```

## ⚠️ 潜在问题点

### 问题 1: Tripo API 没有返回 PBR 模型
**症状**：
```
[TRIPO DEBUG] Selected Model Type: model
[TRIPO DEBUG] ⚠️  WARNING: PBR model not available
```

**解决方案**：
- 检查 Tripo API 计划是否支持 PBR 模型
- 联系 Tripo 支持

### 问题 2: 模型没有颜色信息
**症状**：
```
[VOXELIZER] Unique RGB colours found: 1
[VOXELIZER] WARNING: Only one colour found
[SKILLS] ⚠️  COLOR MAPPING ISSUE: Only one block type found: white_wool
```

**解决方案**：
- 检查 prompt 是否包含颜色要求
- 检查 Tripo API 响应中的 `pbr_model`
- 测试其他带颜色的模型文件

### 问题 3: 颜色提取失败
**症状**：
```
[VOXELIZER] DEBUG: Material found but no color extracted
[SKILLS] Missing block field for entry
```

**解决方案**：
- 检查 voxelizer.py 的颜色提取逻辑
- 检查 GLB 文件格式
- 尝试其他模型文件

## ✅ 验证清单

运行一次完整的构建流程，检查：

- [ ] `[TRIPO DEBUG] Selected Model Type:` 显示 `pbr_model`
- [ ] `[VOXELIZER] Unique RGB colours found:` > 1
- [ ] `[VOXELIZER] Block mapping complete. Unique blocks:` > 1
- [ ] `[SKILLS] Color check (first 100 entries):` 显示多个颜色
- [ ] `[SKILLS] ✓ Color mapping successful:` 显示多个 block 类型
- [ ] `[SKILLS] Placing block:` 显示不同的 block 名称（不只是 white_wool）

## 📝 代码修改总结

### 新增调试功能
1. ✅ JSON 读取时的颜色检查（前 100 个条目）
2. ✅ Blueprint 转换时的颜色验证
3. ✅ 构建时的 RGB → Block 映射日志
4. ✅ 颜色多样性统计和警告

### 修复的问题
1. ✅ 优先使用 PBR 模型
2. ✅ 增强 prompt（要求颜色）
3. ✅ 增强颜色提取逻辑
4. ✅ 添加完整的调试日志链

---

**最后更新**：2024-12-19
**状态**：代码已增强，等待实际测试验证

