#!/usr/bin/env python3
"""
Quick test script for voxelizer color extraction
Created: 2024-12-19
"""

import os
import json
import sys

# Add current directory to path
sys.path.insert(0, os.path.dirname(__file__))

from voxelizer import mesh_to_voxels, map_color_to_block

def test_color_extraction(model_path, resolution=20):
    """Test color extraction from a model file"""
    print("=" * 60)
    print("TESTING VOXELIZER COLOR EXTRACTION")
    print("=" * 60)
    print(f"Model: {model_path}")
    print(f"Resolution: {resolution}")
    print("=" * 60)
    
    if not os.path.exists(model_path):
        print(f"ERROR: Model file not found: {model_path}")
        return False
    
    try:
        # Run voxelization
        data = mesh_to_voxels(model_path, resolution=resolution)
        
        # Analyze colors
        unique_colors = set()
        color_distribution = {}
        block_distribution = {}
        
        for entry in data:
            rgb = (entry['r'], entry['g'], entry['b'])
            unique_colors.add(rgb)
            color_distribution[rgb] = color_distribution.get(rgb, 0) + 1
            
            # Map to block
            block_name = map_color_to_block(entry['r'], entry['g'], entry['b'])
            block_distribution[block_name] = block_distribution.get(block_name, 0) + 1
        
        # Print results
        print("\n" + "=" * 60)
        print("RESULTS")
        print("=" * 60)
        print(f"Total voxels: {len(data)}")
        print(f"Unique RGB colors: {len(unique_colors)}")
        print(f"Unique block types: {len(block_distribution)}")
        
        if len(unique_colors) == 1:
            rgb = list(unique_colors)[0]
            print(f"\n⚠️  WARNING: Only one color found!")
            print(f"RGB: {rgb}")
            print(f"Block: {list(block_distribution.keys())[0]}")
            print("\nPossible reasons:")
            print("1. Model has no color information")
            print("2. Texture sampling failed")
            print("3. All pixels in texture are the same color")
            return False
        else:
            print(f"\n✓ Multiple colors found!")
            print(f"\nTop 10 RGB colors:")
            sorted_colors = sorted(color_distribution.items(), key=lambda x: x[1], reverse=True)[:10]
            for rgb, count in sorted_colors:
                percentage = (count / len(data)) * 100
                block = map_color_to_block(rgb[0], rgb[1], rgb[2])
                print(f"  RGB{rgb}: {count} voxels ({percentage:.1f}%) → {block}")
            
            print(f"\nTop 10 block types:")
            sorted_blocks = sorted(block_distribution.items(), key=lambda x: x[1], reverse=True)[:10]
            for block, count in sorted_blocks:
                percentage = (count / len(data)) * 100
                print(f"  {block}: {count} voxels ({percentage:.1f}%)")
            
            return True
        
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    # Test with latest model
    model_path = "assets/model_1766712176913.glb"
    
    if len(sys.argv) > 1:
        model_path = sys.argv[1]
    
    if len(sys.argv) > 2:
        resolution = int(sys.argv[2])
    else:
        resolution = 20
    
    success = test_color_extraction(model_path, resolution)
    
    if success:
        print("\n" + "=" * 60)
        print("✓ TEST PASSED: Multiple colors detected!")
        print("=" * 60)
        sys.exit(0)
    else:
        print("\n" + "=" * 60)
        print("✗ TEST FAILED: Only one color detected")
        print("=" * 60)
        sys.exit(1)


