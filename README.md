# Project Noël - Minecraft AI Agent

A GPT-4o powered Minecraft agent that can build Christmas-themed structures using natural language commands. Features text-to-3D model generation via Tripo AI and automated voxelization pipeline.

## Architecture

**Core Stack**: Node.js + Python hybrid architecture, driven by OpenAI GPT-4o

**Base Models**:
- Language Understanding & Decision: GPT-4o (OpenAI)
- Text-to-3D Model: Tripo AI API
- 3D Model Voxelization: Python + trimesh + numpy

**Tech Stack**:
- Minecraft Interaction: Mineflayer (Node.js)
- Path Planning: mineflayer-pathfinder
- Model Processing: trimesh (Python)
- Data Format: GLB/OBJ → JSON Blueprint

## Features

- 🤖 Natural language building commands
- 🎨 Text-to-3D model generation (Tripo AI)
- 🧱 Automatic voxelization and blueprint generation
- 🎄 Christmas-themed structure building
- 🚶 Natural behavior system (following, random walk)
- 💬 Conversational AI with clarification flow

## Prerequisites

- Node.js (v16+)
- Python 3.8+
- Minecraft server (1.20.1)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd Noel
```

2. Install Node.js dependencies:
```bash
npm install
```

3. Install Python dependencies:
```bash
pip install -r requirements.txt
```

4. Configure environment variables:
```bash
cp .env.example .env
# Edit .env and add your API keys
```

## Configuration

Create a `.env` file with the following variables:

```env
OPENAI_API_KEY=your_openai_api_key
TRIPO_API_KEY=your_tripo_api_key
```

Optional Minecraft authentication:
```env
MINECRAFT_USERNAME=your_username
MINECRAFT_PASSWORD=your_password
MINECRAFT_AUTH_TYPE=offline
```

## Usage

1. Start your Minecraft server (localhost:25565)

2. Run the agent:
```bash
npm start
# or
node generalised_agent.js
```

3. In-game, chat with the bot:
```
build a Christmas tree
build a small gift box
imagine and build a snowman
```

## Project Structure

```
Noel/
├── agent.js                 # Basic agent implementation
├── generalised_agent.js     # Main agent with full features
├── voxelizer.py            # 3D model to Minecraft blueprint converter
├── voxelizer_pbr.py        # PBR-aware voxelizer with color support
├── convert-litematic.js    # Litematic file converter
├── convert-litematic.py    # Python litematic converter
├── assets/                 # Generated 3D models and blueprints
├── docs/                   # Documentation
└── skins/                  # Custom skins
```

## Documentation

See `docs/` folder for detailed documentation:
- `TEST_GUIDE.md` - Testing guide
- `TRIPO_PBR_REQUIREMENT.md` - Tripo API PBR requirements
- `COLOR_FLOW_CHECK.md` - Color extraction flow

## License

ISC

## Credits

- Built with [Mineflayer](https://github.com/PrismarineJS/mineflayer)
- 3D generation powered by [Tripo AI](https://www.tripo3d.ai)
- Architecture inspired by Silmaril Pattern

