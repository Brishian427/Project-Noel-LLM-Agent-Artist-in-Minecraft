#!/usr/bin/env python3
"""
PBR Texture-Aware Voxelizer for Minecraft Blueprint Generation
Created: 2024-12-19
Optimized for Tripo AI GLB models with PBR textures
Converts 3D models (.obj, .glb, .ply) to Minecraft blueprint format with proper texture extraction
"""

import sys
import json
import os
import time

try:
    import trimesh
    import numpy as np
    try:
        from scipy.spatial import cKDTree
        HAS_SCIPY = True
    except ImportError:
        HAS_SCIPY = False
        print("[WARNING] scipy not available, using slower color matching")
except ImportError as e:
    print(f"[ERROR] Required packages not installed. Import error: {e}")
    print(f"[ERROR] Python executable: {sys.executable}")
    print(f"[ERROR] Python version: {sys.version}")
    print("[ERROR] Please run: pip install trimesh numpy")
    print("[ERROR] Optional: pip install scipy (for faster color matching)")
    sys.exit(1)

def normalize_color_value(val):
    """Normalize color value to 0-255 range"""
    val_float = float(val)
    if val_float <= 1.0:
        return int(val_float * 255)
    elif val_float <= 255:
        return int(val_float)
    elif val_float <= 65535:
        return int(val_float / 256)
    else:
        return max(0, min(255, int(val_float)))

def mesh_to_voxels_pbr(mesh_path, resolution=20, fill=True):
    """
    Convert 3D model to voxel grid with PBR texture extraction
    
    Args:
        mesh_path: Path to 3D model file (.obj, .glb, .ply, etc.)
        resolution: Voxel grid resolution (default: 20 blocks high)
        fill: Whether to fill interior voxels
    
    Returns:
        List of voxel coordinates with colors and block mappings
    """
    try:
        print(f"[PBR VOXELIZER] Loading mesh: {mesh_path}")
        
        # Try to load as scene first (Tripo AI GLB files are usually scenes)
        try:
            scene = trimesh.load(mesh_path, force='scene')
            if isinstance(scene, trimesh.Scene):
                print(f"[PBR VOXELIZER] Loaded as Scene with {len(scene.geometry)} geometries")
                # Combine geometries for voxelization, but preserve original meshes for color sampling
                # Use to_geometry() instead of deprecated dump(concatenate=True)
                try:
                    combined_mesh = scene.to_geometry()
                except AttributeError:
                    # Fallback for older trimesh versions
                    combined_mesh = scene.dump(concatenate=True)
            else:
                combined_mesh = scene
        except:
            # Fallback: load as single mesh
            print(f"[PBR VOXELIZER] Loading as single mesh...")
            combined_mesh = trimesh.load(mesh_path)
        
        # Handle scene objects (extract first mesh if needed)
        if not isinstance(combined_mesh, trimesh.Trimesh):
            if hasattr(combined_mesh, 'geometry'):
                combined_mesh = list(combined_mesh.geometry.values())[0]
            elif isinstance(combined_mesh, trimesh.Scene):
                combined_mesh = combined_mesh.dump(concatenate=True)
        
        if not isinstance(combined_mesh, trimesh.Trimesh):
            raise ValueError(f"Could not extract mesh from file: {mesh_path}")
        
        print(f"[PBR VOXELIZER] Mesh loaded: {len(combined_mesh.vertices)} vertices, {len(combined_mesh.faces)} faces")
        print(f"[PBR VOXELIZER] Original bounds: {combined_mesh.bounds}")
        
        # Normalize: Scale to fit in 0-1 range
        combined_mesh.apply_translation(-combined_mesh.bounds[0])
        scale = 1.0 / combined_mesh.extents.max()
        combined_mesh.apply_scale(scale)
        print(f"[PBR VOXELIZER] Normalized scale: {scale:.4f}")
        
        # Voxelize
        print(f"[PBR VOXELIZER] Voxelizing with resolution {resolution}...")
        pitch = 1.0 / resolution
        voxel_grid = combined_mesh.voxelized(pitch=pitch)
        
        # Fill interior (optional)
        if fill:
            print("[PBR VOXELIZER] Filling interior...")
            voxel_grid = voxel_grid.fill()
        
        # Extract coordinates
        voxels = voxel_grid.points / pitch
        voxels = np.round(voxels).astype(int)
        
        print(f"[PBR VOXELIZER] Generated {len(voxels)} voxels")
        
        # ===== PBR TEXTURE EXTRACTION =====
        print("[PBR VOXELIZER] Extracting colors from PBR textures...")
        
        # Check if mesh has visual/material information
        has_visual = hasattr(combined_mesh, 'visual') and combined_mesh.visual is not None
        has_material = has_visual and hasattr(combined_mesh.visual, 'material') and combined_mesh.visual.material is not None
        
        # Try to bake texture to vertex colors (this is the key!)
        try:
            if has_visual:
                print("[PBR VOXELIZER] Attempting to bake texture to vertex colors...")
                # This converts texture images to vertex colors
                combined_mesh.visual = combined_mesh.visual.to_color()
                print("[PBR VOXELIZER] ✓ Texture baked to vertex colors successfully!")
        except Exception as e:
            print(f"[PBR VOXELIZER] ⚠️  Texture baking failed: {e}")
            print("[PBR VOXELIZER] Falling back to material color extraction...")
        
        # Check for vertex colors (after baking)
        has_vertex_colors = (has_visual and 
                            hasattr(combined_mesh.visual, 'vertex_colors') and 
                            combined_mesh.visual.vertex_colors is not None)
        
        # Check for face colors
        has_face_colors = (has_visual and 
                          hasattr(combined_mesh.visual, 'face_colors') and 
                          combined_mesh.visual.face_colors is not None)
        
        print(f"[PBR VOXELIZER] Vertex colors: {has_vertex_colors}, Face colors: {has_face_colors}, Material: {has_material}")
        
        # Sample colors for each voxel
        export_data = []
        color_source_stats = {}
        
        if has_vertex_colors and len(combined_mesh.visual.vertex_colors) > 0:
            # Use KDTree for fast nearest vertex lookup
            if HAS_SCIPY:
                print("[PBR VOXELIZER] Using scipy.spatial.cKDTree for fast color lookup...")
                tree = cKDTree(combined_mesh.vertices)
                _, vertex_indices = tree.query(voxel_grid.points)
            else:
                print("[PBR VOXELIZER] Using numpy for color lookup (slower)...")
                # Fallback: compute distances manually
                vertex_indices = []
                for voxel_pos in voxel_grid.points:
                    distances = np.linalg.norm(combined_mesh.vertices - voxel_pos, axis=1)
                    vertex_indices.append(np.argmin(distances))
                vertex_indices = np.array(vertex_indices)
            
            print("[PBR VOXELIZER] Sampling colors from vertex colors...")
            vertex_colors = combined_mesh.visual.vertex_colors
            
            for i, v in enumerate(voxels):
                nearest_idx = vertex_indices[i]
                if nearest_idx < len(vertex_colors):
                    color = vertex_colors[nearest_idx]
                    r = normalize_color_value(color[0])
                    g = normalize_color_value(color[1])
                    b = normalize_color_value(color[2])
                    color_source = "vertex_baked"
                else:
                    r, g, b = 255, 255, 255
                    color_source = "default"
                
                color_source_stats[color_source] = color_source_stats.get(color_source, 0) + 1
                
                export_data.append({
                    "x": int(v[0]),
                    "y": int(v[1]),
                    "z": int(v[2]),
                    "r": r,
                    "g": g,
                    "b": b
                })
        elif has_face_colors:
            # Use face colors
            print("[PBR VOXELIZER] Sampling colors from face colors...")
            face_colors = combined_mesh.visual.face_colors
            face_centers = combined_mesh.triangles_center
            
            if HAS_SCIPY:
                tree = cKDTree(face_centers)
                _, face_indices = tree.query(voxel_grid.points)
            else:
                face_indices = []
                for voxel_pos in voxel_grid.points:
                    distances = np.linalg.norm(face_centers - voxel_pos, axis=1)
                    face_indices.append(np.argmin(distances))
                face_indices = np.array(face_indices)
            
            for i, v in enumerate(voxels):
                nearest_idx = face_indices[i]
                if nearest_idx < len(face_colors):
                    color = face_colors[nearest_idx]
                    r = normalize_color_value(color[0])
                    g = normalize_color_value(color[1])
                    b = normalize_color_value(color[2])
                    color_source = "face"
                else:
                    r, g, b = 255, 255, 255
                    color_source = "default"
                
                color_source_stats[color_source] = color_source_stats.get(color_source, 0) + 1
                
                export_data.append({
                    "x": int(v[0]),
                    "y": int(v[1]),
                    "z": int(v[2]),
                    "r": r,
                    "g": g,
                    "b": b
                })
        else:
            # Fallback: try material color
            print("[PBR VOXELIZER] No vertex/face colors, trying material color...")
            r, g, b = 255, 255, 255  # Default white
            
            if has_material:
                try:
                    material = combined_mesh.visual.material
                    if hasattr(material, 'baseColorFactor') and material.baseColorFactor is not None:
                        color = material.baseColorFactor
                        r = normalize_color_value(color[0])
                        g = normalize_color_value(color[1])
                        b = normalize_color_value(color[2])
                        color_source = "material_baseColor"
                    elif hasattr(material, 'main_color') and material.main_color is not None:
                        color = material.main_color
                        r = normalize_color_value(color[0])
                        g = normalize_color_value(color[1])
                        b = normalize_color_value(color[2])
                        color_source = "material_main"
                except Exception as e:
                    print(f"[PBR VOXELIZER] Material color extraction failed: {e}")
                    color_source = "default"
            else:
                color_source = "default"
            
            # Apply same color to all voxels
            for v in voxels:
                export_data.append({
                    "x": int(v[0]),
                    "y": int(v[1]),
                    "z": int(v[2]),
                    "r": r,
                    "g": g,
                    "b": b
                })
            color_source_stats[color_source] = len(voxels)
        
        # Count color diversity
        unique_colors = set()
        for entry in export_data:
            unique_colors.add((entry['r'], entry['g'], entry['b']))
        
        print(f"[PBR VOXELIZER] Color extraction complete")
        print(f"[PBR VOXELIZER] Unique RGB colors found: {len(unique_colors)}")
        if color_source_stats:
            print(f"[PBR VOXELIZER] Color source statistics: {color_source_stats}")
        
        if len(unique_colors) == 1:
            print(f"[PBR VOXELIZER] ⚠️  WARNING: Only one color found - model may not have color information!")
            print(f"[PBR VOXELIZER] RGB: ({export_data[0]['r']}, {export_data[0]['g']}, {export_data[0]['b']})")
        else:
            r_values = [e['r'] for e in export_data]
            g_values = [e['g'] for e in export_data]
            b_values = [e['b'] for e in export_data]
            print(f"[PBR VOXELIZER] ✓ Multiple colors found!")
            print(f"[PBR VOXELIZER] RGB range: R({min(r_values)}-{max(r_values)}), G({min(g_values)}-{max(g_values)}), B({min(b_values)}-{max(b_values)})")
        
        return export_data
        
    except Exception as e:
        print(f"[PBR VOXELIZER] Error processing mesh: {e}")
        import traceback
        traceback.print_exc()
        raise

def map_color_to_block(r, g, b):
    """
    Map RGB colour to Minecraft block name using simplified, clean color palette
    Prioritizes common building blocks: concrete, gem blocks, wool, wood, stone, quartz, leaves
    Avoids excessive grayscale and ensures consistent color mapping
    
    STRICT MATERIAL RULES:
    - Human skin colors ONLY: white_terracotta (PRIORITY #1) or smooth_sandstone (PRIORITY #2)
    - White colors (snow, etc.): snow_block or quartz_block (NEVER white_terracotta unless skin)
    - White terracotta is STRICTLY LIMITED to skin colors only
    """
    # Calculate brightness and saturation
    brightness = (r + g + b) / 3.0
    max_rgb = max(r, g, b)
    min_rgb = min(r, g, b)
    saturation = (max_rgb - min_rgb) / 255.0 if max_rgb > 0 else 0
    
    # CRITICAL: Detect human skin colors ONLY
    # Human skin typically has: R > G > B, with R and G being relatively high
    # Skin color ranges: pink tones (R: 200-255, G: 150-220, B: 100-180)
    #                    flesh tones (R: 220-255, G: 180-230, B: 140-200)
    #                    light brown skin (R: 180-220, G: 140-180, B: 100-140)
    is_skin_color = False
    if r > g > b:  # Red > Green > Blue (typical skin tone pattern)
        # Check for pink/flesh tones (bright skin)
        if (200 <= r <= 255 and 150 <= g <= 230 and 100 <= b <= 200):
            is_skin_color = True
        # Check for light brown skin tones
        elif (180 <= r <= 220 and 140 <= g <= 180 and 100 <= b <= 140):
            is_skin_color = True
        # Check for medium skin tones
        elif (160 <= r <= 200 and 120 <= g <= 160 and 80 <= b <= 120):
            is_skin_color = True
    
    # If detected as skin color, force mapping to white_terracotta or smooth_sandstone (never yellow_wool or pink)
    if is_skin_color:
        # PRIORITY: white_terracotta (most fit and suitable) or smooth_sandstone
        # NEVER use yellow_wool for skin colors
        if brightness > 200:
            return 'white_terracotta'  # Very light skin -> white_terracotta (priority #1)
        elif brightness > 160:
            return 'white_terracotta'  # Light to medium skin -> white_terracotta (priority #1)
        else:
            return 'smooth_sandstone'  # Medium skin -> smooth_sandstone (priority #2)
    
    # CRITICAL: White colors (snow, etc.) should map to snow_block or quartz_block, NOT white_terracotta
    # Check if color is white/very light (high brightness, low saturation)
    # RELAXED: Lower threshold to catch more white/light colors for snow objects
    is_white_color = brightness > 180 and saturation < 0.25
    if is_white_color:
        # White colors -> snow_block or quartz_block (prefer snow_block for very white)
        if brightness > 220:
            return 'snow_block'  # Very white -> snow_block (preferred for snow)
        elif brightness > 200:
            return 'snow_block'  # Bright white -> snow_block
        else:
            return 'quartz_block'  # Light white -> quartz_block
    
    # Simplified, clean color palette - prioritizing common building blocks
    # Organized by color families to ensure consistent mapping
    # NOTE: white_terracotta is REMOVED from general palette - only used for skin colors
    colour_palette = [
        # White/Light - Snow block and Quartz (for white colors, NOT white_terracotta)
        ('snow_block', (255, 255, 255)),  # Pure white -> snow_block
        ('quartz_block', (255, 255, 255)),  # Alternative white -> quartz_block
        ('white_concrete', (255, 255, 255)),
        
        # Red - Concrete and Wool (vibrant, clean)
        ('red_concrete', (142, 32, 32)),
        ('red_wool', (153, 51, 51)),
        
        # Orange - Concrete and Wool
        ('orange_concrete', (224, 97, 1)),
        ('orange_wool', (216, 127, 51)),
        
        # Yellow - Gold block and Concrete (premium look)
        ('gold_block', (249, 198, 40)),
        ('yellow_concrete', (235, 157, 52)),
        ('yellow_wool', (229, 229, 51)),
        
        # Green - Emerald block, Concrete, Wool, Leaves
        ('emerald_block', (17, 158, 66)),
        ('green_concrete', (97, 153, 97)),
        ('green_wool', (127, 204, 25)),
        ('oak_leaves', (0, 124, 0)),  # Dark green for leaves
        
        # Blue - Lapis block, Concrete, Wool
        ('lapis_block', (30, 67, 140)),
        ('blue_concrete', (45, 47, 143)),
        ('blue_wool', (51, 76, 178)),
        ('light_blue_concrete', (36, 137, 199)),
        
        # Purple/Magenta - Concrete and Wool
        ('purple_concrete', (100, 32, 156)),
        ('purple_wool', (127, 63, 178)),
        ('magenta_concrete', (169, 48, 159)),
        ('magenta_wool', (178, 76, 216)),
        
        # Pink - Concrete and Wool
        ('pink_concrete', (214, 101, 143)),
        ('pink_wool', (242, 127, 165)),
        
        # Brown - Wood and Concrete (natural materials)
        ('oak_wood', (102, 76, 51)),
        ('spruce_wood', (58, 37, 16)),
        ('brown_concrete', (96, 60, 32)),
        ('brown_wool', (102, 76, 51)),
        
        # Cyan - Concrete and Wool
        ('cyan_concrete', (21, 119, 136)),
        ('cyan_wool', (76, 127, 153)),
        
        # Stone/Gray - Stone variants (minimal grayscale, only when necessary)
        # PRIORITY for skin: smooth_sandstone (priority #2)
        ('smooth_sandstone', (216, 202, 157)),  # Skin color priority #2
        ('stone', (125, 125, 125)),
        ('cobblestone', (125, 125, 125)),
        ('gray_concrete', (55, 58, 62)),
        ('light_gray_concrete', (125, 125, 115)),
        
        # Black - Obsidian and Concrete (minimal use)
        ('obsidian', (20, 18, 29)),
        ('black_concrete', (8, 10, 15)),
    ]
    
    # Find closest matching colour using Euclidean distance in RGB space
    min_distance = float('inf')
    best_block = 'quartz_block'  # Default to quartz (clean, simple)
    
    # CRITICAL: Filter out white_terracotta from general palette matching
    # white_terracotta should ONLY be used for skin colors (already handled above)
    filtered_palette = [(name, color) for name, color in colour_palette 
                       if name != 'white_terracotta']
    
    # CRITICAL: For white colors, prioritize snow_block and quartz_block, exclude smooth_sandstone and stone
    # smooth_sandstone should ONLY be used for skin colors (medium skin tones)
    # stone should NOT be used for white/light colors (snow objects)
    if is_white_color and not is_skin_color:
        # For white colors that are NOT skin, exclude smooth_sandstone and stone variants
        filtered_palette = [(name, color) for name, color in filtered_palette 
                           if name != 'smooth_sandstone' and 
                              name != 'stone' and 
                              name != 'cobblestone' and
                              name != 'light_gray_concrete']
    
    # Skin color filter: exclude yellow_wool from palette when matching skin colors
    if is_skin_color:
        # Remove yellow_wool from consideration for skin colors (pink blocks are allowed)
        # NEVER use yellow_wool for skin - use white_terracotta or smooth_sandstone instead
        filtered_palette = [(name, color) for name, color in filtered_palette 
                           if name != 'yellow_wool']
    
    for block_name, (pr, pg, pb) in filtered_palette:
        # Calculate distance in RGB space
        distance = np.sqrt((r - pr)**2 + (g - pg)**2 + (b - pb)**2)
        if distance < min_distance:
            min_distance = distance
            best_block = block_name
    
    # Final check: if best_block is yellow_wool and we detected skin color, override to white_terracotta/smooth_sandstone
    if is_skin_color and best_block == 'yellow_wool':
        # PRIORITY: white_terracotta (most fit) or smooth_sandstone
        if brightness > 200:
            return 'white_terracotta'  # Very light skin -> white_terracotta (priority #1)
        else:
            return 'smooth_sandstone'  # Medium skin -> smooth_sandstone (priority #2)
    
    # CRITICAL: If best_block somehow ended up as white_terracotta (shouldn't happen), replace with snow_block or quartz_block
    if best_block == 'white_terracotta' and not is_skin_color:
        # This should never happen due to filtering, but safety check
        if brightness > 240:
            return 'snow_block'
        else:
            return 'quartz_block'
    
    # CRITICAL: If best_block is smooth_sandstone but this is NOT a skin color, replace with appropriate block
    # smooth_sandstone should ONLY be used for medium skin tones
    if best_block == 'smooth_sandstone' and not is_skin_color:
        # Not skin color -> use snow_block or quartz_block for white/light colors
        if brightness > 20:
            return 'snow_block'  # Bright colors -> snow_block (preferred for snow)
        elif brightness > 18:
            return 'quartz_block'  # Light colors -> quartz_block
        else:
            return best_block  # Keep for darker colors
    
    # Improved grayscale handling - minimize gray usage, prefer colored blocks
    # CRITICAL: For high brightness colors, prioritize snow_block/quartz_block over stone
    # Only use gray/stone if saturation is extremely low AND brightness is mid-range
    if saturation < 0.15:  # Very low saturation (almost grayscale)
        if brightness > 200:
            # Very bright white -> snow_block (preferred for snow objects)
            return 'snow_block'
        elif brightness > 180:
            # Bright white -> snow_block or quartz_block (NOT stone)
            return 'snow_block' if brightness > 190 else 'quartz_block'
        elif brightness > 150:
            # Light gray -> quartz_block (NOT stone)
            return 'quartz_block'
        elif brightness > 120:
            # Mid brightness - prefer stone over gray
            if min_distance > 80:
                return 'stone'
        elif brightness > 60:
            # Dark but not black - prefer darker stone
            if min_distance > 80:
                return 'cobblestone'
        elif brightness > 30:
            # Very dark - use obsidian
            if min_distance > 80:
                return 'obsidian'
        else:
            # Extremely dark
            return 'obsidian'
    
    # For low brightness colors, ensure we don't use very bright blocks
    if brightness < 50 and best_block in ['quartz_block', 'white_concrete', 'yellow_wool']:
        if min_distance > 100:
            return 'obsidian'
    
    return best_block

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python voxelizer_pbr.py <input_file> <output_file> [resolution]")
        print("Example: python voxelizer_pbr.py horse.obj blueprint.json 20")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    resolution = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    
    if not os.path.exists(input_file):
        print(f"[ERROR] Input file not found: {input_file}")
        sys.exit(1)
    
    print("=" * 50)
    print("[PBR VOXELIZER] Starting PBR-aware voxelization process")
    print("=" * 50)
    print(f"[PBR VOXELIZER] Input: {input_file}")
    print(f"[PBR VOXELIZER] Output: {output_file}")
    print(f"[PBR VOXELIZER] Resolution: {resolution}")
    print("=" * 50)
    
    start_time = time.time()
    
    try:
        # Generate voxels with PBR texture extraction
        data = mesh_to_voxels_pbr(input_file, resolution=resolution)
        
        # Apply color mapping
        print("[PBR VOXELIZER] Mapping colors to Minecraft blocks...")
        block_counts = {}
        for voxel in data:
            block_name = map_color_to_block(voxel['r'], voxel['g'], voxel['b'])
            voxel['block'] = block_name
            block_counts[block_name] = block_counts.get(block_name, 0) + 1
        
        # Log block distribution
        print(f"[PBR VOXELIZER] Block mapping complete. Unique blocks: {len(block_counts)}")
        if len(block_counts) <= 5:
            print(f"[PBR VOXELIZER] Block distribution: {block_counts}")
        if len(block_counts) == 1:
            print(f"[PBR VOXELIZER] WARNING: Only one block type - color mapping may have failed or model has no colors!")
        
        # Save JSON
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2)
        
        elapsed_time = time.time() - start_time
        print("=" * 50)
        print(f"[PBR VOXELIZER] Success! Generated {len(data)} voxels")
        print(f"[PBR VOXELIZER] Saved to: {output_file}")
        print(f"[PBR VOXELIZER] Processing time: {elapsed_time:.2f} seconds ({elapsed_time/60:.2f} minutes)")
        print("=" * 50)
        
    except Exception as e:
        print(f"[PBR VOXELIZER] Failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

