#!/usr/bin/env python3
"""
Litematic to Blueprint Converter
Created: 2024-12-19
Converts .litematic files to agent.js blueprint format
"""

import sys
import json
import os

try:
    from litemapy import Schematic, Region, BlockState
except ImportError:
    print("Error: litemapy not found. Installing...")
    print("Please run: pip install litemapy")
    sys.exit(1)

def convert_litematic_to_blueprint(file_path):
    """Convert litematic file to blueprint format"""
    try:
        print(f"[CONVERT] Reading litematic file: {file_path}")
        
        # Load schematic
        schematic = Schematic.load(file_path)
        
        print(f"[CONVERT] Schematic name: {schematic.name}")
        print(f"[CONVERT] Number of regions: {len(schematic.regions)}")
        
        # Get the first region (or iterate through all)
        region_name = list(schematic.regions.keys())[0]
        region = schematic.regions[region_name]
        
        print(f"[CONVERT] Processing region: {region_name}")
        print(f"[CONVERT] Region size: {region.width} x {region.height} x {region.length}")
        print(f"[CONVERT] Region position: {region.x} x {region.y} x {region.z}")
        
        # Debug: Check region attributes
        print(f"[CONVERT] Region attributes: {dir(region)}")
        
        # Try to get blocks using different methods
        try:
            # Method 1: Check if there's a blocks attribute
            if hasattr(region, 'blocks'):
                print(f"[CONVERT] Found 'blocks' attribute, type: {type(region.blocks)}")
                print(f"[CONVERT] Number of blocks: {len(region.blocks) if hasattr(region.blocks, '__len__') else 'N/A'}")
        except Exception as e:
            print(f"[CONVERT] Error checking blocks attribute: {e}")
        
        # Get minimum coordinates to normalize to origin
        min_x = region.x
        min_y = region.y
        min_z = region.z
        
        # Collect all blocks
        blueprint = []
        block_count = 0
        
        print("[CONVERT] Extracting blocks...")
        
        # Use block_positions() method to iterate through all blocks
        try:
            # Get all block positions
            positions = list(region.block_positions())
            print(f"[CONVERT] Found {len(positions)} block positions")
            
            # Get minimum coordinates to normalize to origin
            if positions:
                min_x = min(pos[0] for pos in positions)
                min_y = min(pos[1] for pos in positions)
                min_z = min(pos[2] for pos in positions)
            else:
                min_x = region.x
                min_y = region.y
                min_z = region.z
            
            # Iterate through all block positions
            for x, y, z in positions:
                try:
                    # Use array-style syntax: region[x, y, z]
                    block = region[x, y, z]
                    
                    # Skip air blocks or None
                    if block is None:
                        continue
                    
                    block_id = str(block)
                    if block_id == "minecraft:air" or block_id == "air":
                        continue
                    
                    # Calculate relative position (normalize to origin)
                    rel_x = x - min_x
                    rel_y = y - min_y
                    rel_z = z - min_z
                    
                    # Remove 'minecraft:' prefix
                    block_name = block_id.replace("minecraft:", "")
                    
                    # Remove block states (everything in brackets like [snowy=false])
                    # Keep only the base block name
                    if '[' in block_name:
                        block_name = block_name.split('[')[0]
                    
                    blueprint.append({
                        'block': block_name,
                        'pos': {'x': rel_x, 'y': rel_y, 'z': rel_z}
                    })
                    block_count += 1
                except Exception as e:
                    # Debug: print first few errors
                    if block_count < 5:
                        print(f"[CONVERT] Warning at ({x}, {y}, {z}): {e}")
        except Exception as e:
            print(f"[CONVERT] Error using block_positions(): {e}")
            print("[CONVERT] Trying alternative method...")
            
            # Fallback: try allblockpos
            try:
                positions = list(region.allblockpos())
                print(f"[CONVERT] Found {len(positions)} block positions (allblockpos)")
                
                if positions:
                    min_x = min(pos[0] for pos in positions)
                    min_y = min(pos[1] for pos in positions)
                    min_z = min(pos[2] for pos in positions)
                else:
                    min_x = region.x
                    min_y = region.y
                    min_z = region.z
                
                for x, y, z in positions:
                    try:
                        block = region[x, y, z]
                        if block is None:
                            continue
                        
                        block_id = str(block)
                        if block_id == "minecraft:air" or block_id == "air":
                            continue
                        
                        rel_x = x - min_x
                        rel_y = y - min_y
                        rel_z = z - min_z
                        
                        block_name = block_id.replace("minecraft:", "")
                        
                        blueprint.append({
                            'block': block_name,
                            'pos': {'x': rel_x, 'y': rel_y, 'z': rel_z}
                        })
                        block_count += 1
                    except Exception as e:
                        if block_count < 5:
                            print(f"[CONVERT] Warning at ({x}, {y}, {z}): {e}")
            except Exception as e2:
                print(f"[CONVERT] Error using allblockpos(): {e2}")
        
        print(f"[CONVERT] Generated {block_count} non-air blocks")
        
        # Sort by Y, then Z, then X for better readability
        blueprint.sort(key=lambda b: (b['pos']['y'], b['pos']['z'], b['pos']['x']))
        
        # Output blueprint code
        print('\n// ==========================================')
        print('// Generated Blueprint Code')
        print('// ==========================================\n')
        print('const blueprint = [')
        
        for i, entry in enumerate(blueprint):
            comma = ',' if i < len(blueprint) - 1 else ''
            print(f"    {{ block: '{entry['block']}', pos: new Vec3({entry['pos']['x']}, {entry['pos']['y']}, {entry['pos']['z']}) }}{comma}")
        
        print('];\n')
        print('// ==========================================')
        print(f'// Total blocks: {block_count}')
        print('// ==========================================\n')
        
        # Also save to JavaScript format file
        output_file = 'blueprint-output.txt'
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write('const blueprint = [\n')
            for i, entry in enumerate(blueprint):
                comma = ',' if i < len(blueprint) - 1 else ''
                f.write(f"    {{ block: '{entry['block']}', pos: new Vec3({entry['pos']['x']}, {entry['pos']['y']}, {entry['pos']['z']}) }}{comma}\n")
            f.write('];\n')
        
        print(f"[CONVERT] Blueprint code saved to: {output_file}")
        
        # Also save to JSON format (for agent.js to load)
        json_file = 'blueprint.json'
        blueprint_data = {
            'name': schematic.name if hasattr(schematic, 'name') else 'Blueprint',
            'source': litematic_file,
            'total_blocks': len(blueprint),
            'blocks': blueprint
        }
        
        import json
        with open(json_file, 'w', encoding='utf-8') as f:
            json.dump(blueprint_data, f, indent=2)
        
        print(f"[CONVERT] Blueprint JSON saved to: {json_file}")
        
        return blueprint
        
    except Exception as e:
        print(f"[CONVERT] Error converting litematic file: {e}")
        import traceback
        traceback.print_exc()
        return None

if __name__ == "__main__":
    litematic_file = sys.argv[1] if len(sys.argv) > 1 else '17353.litematic'
    
    if not os.path.exists(litematic_file):
        print(f"[CONVERT] File not found: {litematic_file}")
        print("[CONVERT] Usage: python convert-litematic.py <path-to-litematic-file>")
        sys.exit(1)
    
    convert_litematic_to_blueprint(litematic_file)

