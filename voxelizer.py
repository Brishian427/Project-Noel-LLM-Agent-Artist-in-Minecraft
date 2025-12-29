#!/usr/bin/env python3
"""
3D Model Voxelizer for Minecraft Blueprint Generation
Created: 2024-12-19
Converts 3D models (.obj, .glb, .ply) to Minecraft blueprint format
"""

import sys
import json
import os
import time

try:
    import trimesh
    import numpy as np
except ImportError as e:
    print(f"[ERROR] Required packages not installed. Import error: {e}")
    print(f"[ERROR] Python executable: {sys.executable}")
    print(f"[ERROR] Python version: {sys.version}")
    print("[ERROR] Please run: pip install trimesh numpy")
    print("[ERROR] Note: scipy is optional (only needed for some advanced trimesh features)")
    sys.exit(1)

def mesh_to_voxels(mesh_path, resolution=20, fill=True):
    """
    Convert 3D model to voxel grid
    
    Args:
        mesh_path: Path to 3D model file (.obj, .glb, .ply, etc.)
        resolution: Voxel grid resolution (default: 20 blocks high)
        fill: Whether to fill interior voxels
    
    Returns:
        List of voxel coordinates with colors and block mappings
    """
    try:
        # 1. Load mesh
        print(f"[VOXELIZER] Loading mesh: {mesh_path}")
        mesh = trimesh.load(mesh_path)
        
        # Handle scene objects (extract first mesh)
        if not isinstance(mesh, trimesh.Trimesh):
            if hasattr(mesh, 'geometry'):
                mesh = list(mesh.geometry.values())[0]
            elif isinstance(mesh, trimesh.Scene):
                mesh = mesh.dump(concatenate=True)
        
        if not isinstance(mesh, trimesh.Trimesh):
            raise ValueError(f"Could not extract mesh from file: {mesh_path}")
        
        print(f"[VOXELIZER] Mesh loaded: {len(mesh.vertices)} vertices, {len(mesh.faces)} faces")
        print(f"[VOXELIZER] Original bounds: {mesh.bounds}")
        
        # 2. Normalize: Scale to fit in 0-1 range
        mesh.apply_translation(-mesh.bounds[0])  # Move to origin
        scale = 1.0 / mesh.extents.max()
        mesh.apply_scale(scale)
        print(f"[VOXELIZER] Normalized scale: {scale:.4f}")
        
        # 3. Voxelize
        print(f"[VOXELIZER] Voxelizing with resolution {resolution}...")
        pitch = 1.0 / resolution
        voxel_grid = mesh.voxelized(pitch=pitch)
        
        # 4. Fill interior (optional)
        if fill:
            print("[VOXELIZER] Filling interior...")
            voxel_grid = voxel_grid.fill()
        
        # 5. Extract coordinates
        voxels = voxel_grid.points / pitch
        voxels = np.round(voxels).astype(int)
        
        print(f"[VOXELIZER] Generated {len(voxels)} voxels")
        
        # 6. Extract color information from mesh
        print("[VOXELIZER] Extracting colours from mesh...")
        
        # Check for vertex colours
        has_vertex_colors = hasattr(mesh.visual, 'vertex_colors') and mesh.visual.vertex_colors is not None
        has_face_colors = hasattr(mesh.visual, 'face_colors') and mesh.visual.face_colors is not None
        has_material = hasattr(mesh.visual, 'material') and mesh.visual.material is not None
        
        # Check for texture/UV coordinates
        has_uv = hasattr(mesh, 'visual') and hasattr(mesh.visual, 'uv') and mesh.visual.uv is not None
        has_texture = False
        texture_image = None
        
        if has_material:
            try:
                material = mesh.visual.material
                # Check for texture image
                if hasattr(material, 'image') and material.image is not None:
                    has_texture = True
                    texture_image = material.image
                    print(f"[VOXELIZER] Texture found: {texture_image.shape if hasattr(texture_image, 'shape') else 'unknown size'}")
                elif hasattr(material, 'baseColorTexture') and material.baseColorTexture is not None:
                    has_texture = True
                    texture_image = material.baseColorTexture
                    print(f"[VOXELIZER] Base color texture found")
                elif hasattr(material, 'diffuseTexture') and material.diffuseTexture is not None:
                    has_texture = True
                    texture_image = material.diffuseTexture
                    print(f"[VOXELIZER] Diffuse texture found")
            except Exception as e:
                print(f"[VOXELIZER] DEBUG: Error checking texture: {e}")
        
        print(f"[VOXELIZER] Vertex colours: {has_vertex_colors}, Face colours: {has_face_colors}, Material: {has_material}, UV: {has_uv}, Texture: {has_texture}")
        
        # Debug: Print material details
        if has_material:
            try:
                material = mesh.visual.material
                print(f"[VOXELIZER] Material type: {type(material)}")
                if hasattr(material, '__dict__'):
                    print(f"[VOXELIZER] Material attributes: {list(material.__dict__.keys())[:10]}")  # First 10 attributes
            except:
                pass
        
        # 7. Sample colours for each voxel
        export_data = []
        color_source_stats = {}  # Track color sources for debugging
        for v in voxels:
            voxel_pos = v.astype(float) * pitch  # Convert back to normalized coordinates
            
            # Helper function to normalize color values to 0-255 range
            def normalize_color_value(val):
                """Normalize color value to 0-255 range"""
                # Handle different formats:
                # - 0-1 range (float): multiply by 255
                # - 0-255 range (uint8): use as-is
                # - 0-65535 range (uint16): divide by 256
                val_float = float(val)
                if val_float <= 1.0:
                    return int(val_float * 255)
                elif val_float <= 255:
                    return int(val_float)
                elif val_float <= 65535:
                    return int(val_float / 256)
                else:
                    # Fallback: clamp to 0-255
                    return max(0, min(255, int(val_float)))
            
            # Try to sample colour from mesh
            r, g, b = 255, 255, 255  # Default white
            color_source = "default"
            
            if has_vertex_colors:
                # Find nearest vertex and use its colour
                distances = np.linalg.norm(mesh.vertices - voxel_pos, axis=1)
                nearest_vertex_idx = np.argmin(distances)
                if nearest_vertex_idx < len(mesh.visual.vertex_colors):
                    color = mesh.visual.vertex_colors[nearest_vertex_idx]
                    if len(color) >= 3:
                        r = normalize_color_value(color[0])
                        g = normalize_color_value(color[1])
                        b = normalize_color_value(color[2])
                        color_source = "vertex"
            elif has_face_colors:
                # Find nearest face and use its colour
                # Get face centres
                face_centres = mesh.triangles_center
                distances = np.linalg.norm(face_centres - voxel_pos, axis=1)
                nearest_face_idx = np.argmin(distances)
                if nearest_face_idx < len(mesh.visual.face_colors):
                    color = mesh.visual.face_colors[nearest_face_idx]
                    if len(color) >= 3:
                        r = normalize_color_value(color[0])
                        g = normalize_color_value(color[1])
                        b = normalize_color_value(color[2])
                        color_source = "face"
            elif has_material:
                # Try to get material colour
                try:
                    material = mesh.visual.material
                    # Try multiple material color properties
                    color_found = False
                    
                    # Try main_color first
                    if hasattr(material, 'main_color') and material.main_color is not None:
                        color = material.main_color
                        if len(color) >= 3:
                            r = normalize_color_value(color[0])
                            g = normalize_color_value(color[1])
                            b = normalize_color_value(color[2])
                            color_source = "material_main"
                            color_found = True
                    
                    # Try diffuse if main_color didn't work
                    if not color_found and hasattr(material, 'diffuse') and material.diffuse is not None:
                        color = material.diffuse
                        if len(color) >= 3:
                            r = normalize_color_value(color[0])
                            g = normalize_color_value(color[1])
                            b = normalize_color_value(color[2])
                            color_source = "material_diffuse"
                            color_found = True
                    
                    # Try baseColorFactor (glTF/GLB format)
                    if not color_found and hasattr(material, 'baseColorFactor') and material.baseColorFactor is not None:
                        color = material.baseColorFactor
                        if len(color) >= 3:
                            r = normalize_color_value(color[0])
                            g = normalize_color_value(color[1])
                            b = normalize_color_value(color[2])
                            color_source = "material_baseColor"
                            color_found = True
                    
                    # Try to get color from material properties dict
                    if not color_found and hasattr(material, 'properties'):
                        props = material.properties
                        if isinstance(props, dict):
                            # Check common color property names
                            for prop_name in ['baseColorFactor', 'diffuse', 'color', 'baseColor']:
                                if prop_name in props:
                                    color = props[prop_name]
                                    if isinstance(color, (list, tuple)) and len(color) >= 3:
                                        r = normalize_color_value(color[0])
                                        g = normalize_color_value(color[1])
                                        b = normalize_color_value(color[2])
                                        color_source = f"material_{prop_name}"
                                        color_found = True
                                        break
                    
                    # Debug: print material info if no color found
                    if not color_found:
                        print(f"[VOXELIZER] DEBUG: Material found but no color extracted. Material type: {type(material)}")
                        if hasattr(material, '__dict__'):
                            print(f"[VOXELIZER] DEBUG: Material attributes: {list(material.__dict__.keys())}")
                            
                except Exception as e:
                    print(f"[VOXELIZER] DEBUG: Error extracting material color: {e}")
                    pass
            
            # If no color found, try to sample from texture if available
            if (r == 255 and g == 255 and b == 255) and has_texture and texture_image is not None:
                try:
                    # Find nearest face to get UV coordinates
                    face_centres = mesh.triangles_center
                    distances = np.linalg.norm(face_centres - voxel_pos, axis=1)
                    nearest_face_idx = np.argmin(distances)
                    
                    if nearest_face_idx < len(mesh.faces):
                        face = mesh.faces[nearest_face_idx]
                        
                        # Get UV coordinates for this face
                        if has_uv and hasattr(mesh.visual, 'uv'):
                            try:
                                # Get UV coordinates for the three vertices of the face
                                uv_coords = mesh.visual.uv[face]
                                
                                # Calculate barycentric coordinates (simplified - use center)
                                uv_center = uv_coords.mean(axis=0)
                                
                                # Sample texture at UV coordinates
                                # Convert UV (0-1) to pixel coordinates
                                if hasattr(texture_image, 'shape'):
                                    h, w = texture_image.shape[:2]
                                    u_pixel = int(uv_center[0] * w) % w
                                    v_pixel = int((1 - uv_center[1]) * h) % h  # Flip V coordinate
                                    
                                    # Sample pixel color
                                    if len(texture_image.shape) == 3:  # RGB/RGBA image
                                        pixel_color = texture_image[v_pixel, u_pixel]
                                        if len(pixel_color) >= 3:
                                            r = normalize_color_value(pixel_color[0])
                                            g = normalize_color_value(pixel_color[1])
                                            b = normalize_color_value(pixel_color[2])
                                            color_source = "texture"
                                    elif len(texture_image.shape) == 2:  # Grayscale
                                        gray = normalize_color_value(texture_image[v_pixel, u_pixel])
                                        r = g = b = gray
                                        color_source = "texture_grayscale"
                            except Exception as uv_error:
                                # If UV sampling fails, try to get average texture color
                                try:
                                    if hasattr(texture_image, 'shape') and len(texture_image.shape) == 3:
                                        # Use average color of texture
                                        avg_color = texture_image.mean(axis=(0, 1))
                                        if len(avg_color) >= 3:
                                            r = normalize_color_value(avg_color[0])
                                            g = normalize_color_value(avg_color[1])
                                            b = normalize_color_value(avg_color[2])
                                            color_source = "texture_average"
                                except:
                                    pass
                        else:
                            # No UV coordinates - use average texture color
                            try:
                                if hasattr(texture_image, 'shape') and len(texture_image.shape) == 3:
                                    avg_color = texture_image.mean(axis=(0, 1))
                                    if len(avg_color) >= 3:
                                        r = normalize_color_value(avg_color[0])
                                        g = normalize_color_value(avg_color[1])
                                        b = normalize_color_value(avg_color[2])
                                        color_source = "texture_average"
                            except:
                                pass
                except Exception as tex_error:
                    # Texture sampling failed - keep default white
                    pass
            
            # Ensure RGB values are in valid range (safety check)
            r = max(0, min(255, r))
            g = max(0, min(255, g))
            b = max(0, min(255, b))
            
            # Track color source statistics
            color_source_stats[color_source] = color_source_stats.get(color_source, 0) + 1
            
            entry = {
                "x": int(v[0]),
                "y": int(v[1]),
                "z": int(v[2]),
                "r": r,
                "g": g,
                "b": b
            }
            # Add color source for debugging (first 10 entries only)
            if len(export_data) < 10:
                entry["_debug_color_source"] = color_source
            export_data.append(entry)
        
        # Count color diversity for debugging
        unique_colors = set()
        for entry in export_data:
            unique_colors.add((entry['r'], entry['g'], entry['b']))
        
        print(f"[VOXELIZER] Colour extraction complete")
        print(f"[VOXELIZER] Unique RGB colours found: {len(unique_colors)}")
        if color_source_stats:
            print(f"[VOXELIZER] Color source statistics: {color_source_stats}")
        
        if len(unique_colors) == 1:
            print(f"[VOXELIZER] ⚠️  WARNING: Only one colour found - model may not have colour information!")
            print(f"[VOXELIZER] RGB: ({export_data[0]['r']}, {export_data[0]['g']}, {export_data[0]['b']})")
            print(f"[VOXELIZER] ⚠️  This suggests:")
            print(f"[VOXELIZER]   1. Model has no vertex/face/material colors")
            print(f"[VOXELIZER]   2. Model has no texture or texture sampling failed")
            print(f"[VOXELIZER]   3. Texture exists but all pixels are the same color")
        else:
            r_values = [e['r'] for e in export_data]
            g_values = [e['g'] for e in export_data]
            b_values = [e['b'] for e in export_data]
            print(f"[VOXELIZER] ✓ Multiple colors found!")
            print(f"[VOXELIZER] RGB range: R({min(r_values)}-{max(r_values)}), G({min(g_values)}-{max(g_values)}), B({min(b_values)}-{max(b_values)})")
        
        return export_data
        
    except Exception as e:
        print(f"[VOXELIZER] Error processing mesh: {e}")
        import traceback
        traceback.print_exc()
        raise

def map_color_to_block(r, g, b):
    """
    Map RGB colour to Minecraft block name using colour matching
    
    Args:
        r, g, b: RGB values (0-255)
    
    Returns:
        Minecraft block name string
    """
    # Normalize RGB to 0-1
    r_norm = r / 255.0
    g_norm = g / 255.0
    b_norm = b / 255.0
    
    # Calculate brightness and saturation
    brightness = (r + g + b) / 3.0
    max_rgb = max(r, g, b)
    min_rgb = min(r, g, b)
    saturation = (max_rgb - min_rgb) / 255.0 if max_rgb > 0 else 0
    
    # Colour palette: Minecraft blocks with their RGB values
    # Format: (block_name, (r, g, b))
    colour_palette = [
        # White/Light colours
        ('white_wool', (255, 255, 255)),
        ('snow_block', (255, 255, 255)),
        ('quartz_block', (255, 255, 255)),
        ('white_concrete', (255, 255, 255)),
        
        # Red colours
        ('red_wool', (153, 51, 51)),
        ('red_concrete', (142, 32, 32)),
        ('red_terracotta', (142, 60, 46)),
        ('netherrack', (112, 2, 0)),
        
        # Orange colours
        ('orange_wool', (216, 127, 51)),
        ('orange_concrete', (224, 97, 1)),
        ('orange_terracotta', (162, 84, 38)),
        ('pumpkin', (216, 127, 51)),
        
        # Yellow colours
        ('yellow_wool', (229, 229, 51)),
        ('yellow_concrete', (235, 157, 52)),
        ('yellow_terracotta', (186, 133, 36)),
        ('gold_block', (249, 198, 40)),
        
        # Green colours
        ('green_wool', (127, 204, 25)),
        ('green_concrete', (97, 153, 97)),
        ('green_terracotta', (76, 83, 42)),
        ('emerald_block', (17, 158, 66)),
        ('lime_wool', (127, 204, 25)),
        ('lime_concrete', (94, 168, 25)),
        
        # Blue colours
        ('blue_wool', (51, 76, 178)),
        ('blue_concrete', (45, 47, 143)),
        ('blue_terracotta', (74, 60, 91)),
        ('lapis_block', (30, 67, 140)),
        ('light_blue_wool', (102, 153, 216)),
        ('light_blue_concrete', (36, 137, 199)),
        
        # Purple colours
        ('purple_wool', (127, 63, 178)),
        ('purple_concrete', (100, 32, 156)),
        ('purple_terracotta', (118, 70, 86)),
        ('magenta_wool', (178, 76, 216)),
        ('magenta_concrete', (169, 48, 159)),
        
        # Pink colours
        ('pink_wool', (242, 127, 165)),
        ('pink_concrete', (214, 101, 143)),
        ('pink_terracotta', (160, 78, 78)),
        
        # Brown colours
        ('brown_wool', (102, 76, 51)),
        ('brown_concrete', (96, 60, 32)),
        ('brown_terracotta', (77, 51, 36)),
        ('dirt', (134, 96, 67)),
        ('coarse_dirt', (102, 81, 50)),
        
        # Grey colours
        ('gray_wool', (76, 76, 76)),
        ('gray_concrete', (55, 58, 62)),
        ('gray_terracotta', (57, 42, 35)),
        ('light_gray_wool', (153, 153, 153)),
        ('light_gray_concrete', (125, 125, 115)),
        
        # Black colours
        ('black_wool', (25, 25, 25)),
        ('black_concrete', (8, 10, 15)),
        ('black_terracotta', (37, 22, 16)),
        ('obsidian', (20, 18, 29)),
        
        # Special colours
        ('cyan_wool', (76, 127, 153)),
        ('cyan_concrete', (21, 119, 136)),
        ('terracotta', (152, 94, 67)),
    ]
    
    # Find closest matching colour using Euclidean distance in RGB space
    min_distance = float('inf')
    best_block = 'white_wool'  # Default
    
    for block_name, (pr, pg, pb) in colour_palette:
        # Calculate distance in RGB space
        distance = np.sqrt((r - pr)**2 + (g - pg)**2 + (b - pb)**2)
        if distance < min_distance:
            min_distance = distance
            best_block = block_name
    
    # If brightness is very low, prefer darker blocks
    if brightness < 30:
        if min_distance > 100:  # No good match found
            return 'black_wool'
    
    # If saturation is very low (grayscale), use brightness-based selection
    if saturation < 0.1:
        if brightness > 200:
            return 'white_wool'
        elif brightness > 150:
            return 'light_gray_wool'
        elif brightness > 100:
            return 'gray_wool'
        elif brightness > 50:
            return 'black_wool'
        else:
            return 'obsidian'
    
    return best_block

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python voxelizer.py <input_file> <output_file> [resolution]")
        print("Example: python voxelizer.py horse.obj blueprint.json 20")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    resolution = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    
    if not os.path.exists(input_file):
        print(f"[ERROR] Input file not found: {input_file}")
        sys.exit(1)
    
    print("=" * 50)
    print("[VOXELIZER] Starting voxelization process")
    print("=" * 50)
    print(f"[VOXELIZER] Input: {input_file}")
    print(f"[VOXELIZER] Output: {output_file}")
    print(f"[VOXELIZER] Resolution: {resolution}")
    print("=" * 50)
    
    start_time = time.time()
    
    try:
        # Generate voxels
        data = mesh_to_voxels(input_file, resolution=resolution)
        
        # Apply color mapping
        print("[VOXELIZER] Mapping colors to Minecraft blocks...")
        block_counts = {}
        for voxel in data:
            block_name = map_color_to_block(voxel['r'], voxel['g'], voxel['b'])
            voxel['block'] = block_name
            block_counts[block_name] = block_counts.get(block_name, 0) + 1
        
        # Log block distribution
        print(f"[VOXELIZER] Block mapping complete. Unique blocks: {len(block_counts)}")
        if len(block_counts) <= 5:
            print(f"[VOXELIZER] Block distribution: {block_counts}")
        if len(block_counts) == 1:
            print(f"[VOXELIZER] WARNING: Only one block type - color mapping may have failed or model has no colors!")
        
        # Save JSON
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2)
        
        elapsed_time = time.time() - start_time
        print("=" * 50)
        print(f"[VOXELIZER] Success! Generated {len(data)} voxels")
        print(f"[VOXELIZER] Saved to: {output_file}")
        print(f"[VOXELIZER] Processing time: {elapsed_time:.2f} seconds ({elapsed_time/60:.2f} minutes)")
        print("=" * 50)
        
    except Exception as e:
        print(f"[VOXELIZER] Failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

