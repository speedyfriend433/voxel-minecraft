import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D } from 'noise'; // Using simplex-noise library

// --- Constants ---
const CHUNK_SIZE = 16; // Width/Depth in blocks
const CHUNK_HEIGHT = 64; // Height in blocks
const VOXEL_SIZE = 1; // Size of one block in world units

const RENDER_DISTANCE = 4; // Chunks in each direction
const GRAVITY = -20;
const JUMP_VELOCITY = 8;
const PLAYER_HEIGHT = 1.7;
const PLAYER_WIDTH = 0.4;
const REACH_DISTANCE = 5;

// --- Block Types (Example) ---
const BLOCK = {
    AIR: 0,
    GRASS: 1,
    DIRT: 2,
    STONE: 3,
    WOOD: 4,
    LEAVES: 5,
    // Add more...
};

const BLOCK_COLORS = { // Simple colors for non-textured blocks
    [BLOCK.GRASS]: 0x559944,
    [BLOCK.DIRT]: 0x885522,
    [BLOCK.STONE]: 0x808080,
    [BLOCK.WOOD]: 0x996633,
    [BLOCK.LEAVES]: 0x33AA33,
};
const BLOCK_SOLID = { // Basic check if block is collidable/visible
    [BLOCK.AIR]: false,
    [BLOCK.GRASS]: true,
    [BLOCK.DIRT]: true,
    [BLOCK.STONE]: true,
    [BLOCK.WOOD]: true,
    [BLOCK.LEAVES]: true, // Usually transparent, but solid for basic collision
};

// --- Globals ---
let scene, camera, renderer, controls;
let world = {}; // { "x,z": Chunk }
let chunksToUpdate = new Set(); // Chunks needing mesh regeneration
const noise2D = createNoise2D(Math.random); // Noise function for terrain height
const clock = new THREE.Clock();
let playerVelocity = new THREE.Vector3();
let onGround = false;
let currentBlockType = BLOCK.DIRT; // Block type to place

// --- Initialization ---
function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87CEEB); // Sky blue

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.y = CHUNK_HEIGHT + 5; // Start above potential terrain

    renderer = new THREE.WebGLRenderer({ antialias: true }); // Antialias can be costly
    renderer.setSize(window.innerWidth, window.innerHeight);
    // renderer.shadowMap.enabled = true; // Shadows add significant cost
    document.body.appendChild(renderer.domElement);

    // Basic Lighting (No Day/Night Cycle Yet)
    const ambientLight = new THREE.AmbientLight(0xcccccc, 0.7);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(50, 100, 25);
    // directionalLight.castShadow = true; // Performance cost
    scene.add(directionalLight);

    // Controls
    controls = new PointerLockControls(camera, document.body);
    const blocker = document.getElementById('blocker');
    blocker.addEventListener('click', () => controls.lock());
    controls.addEventListener('unlock', () => blocker.style.display = 'flex');
    controls.addEventListener('lock', () => blocker.style.display = 'none');
    scene.add(controls.getObject());

    // Event Listeners
    window.addEventListener('resize', onWindowResize);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('wheel', onMouseWheel); // For toolbar selection

    // Initial World Loading (Around 0,0)
    loadInitialChunks();

    // Start Game Loop
    animate();
}

// --- World & Chunk Management ---
class Chunk {
    constructor(x, z) {
        this.x = x;
        this.z = z;
        this.worldX = x * CHUNK_SIZE;
        this.worldZ = z * CHUNK_SIZE;
        // Flat array: faster access, harder indexing. Index = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x
        this.voxels = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE).fill(BLOCK.AIR);
        this.mesh = null;
        this.generateTerrain();
    }

    // VERY Simple Terrain Generation (Heightmap only)
    generateTerrain() {
        for (let x = 0; x < CHUNK_SIZE; x++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                const worldX = this.worldX + x;
                const worldZ = this.worldZ + z;

                // Basic noise height - adjust scale/amplitude
                const noiseScale = 0.03;
                const height = Math.floor(noise2D(worldX * noiseScale, worldZ * noiseScale) * 10 + CHUNK_HEIGHT / 3);

                for (let y = 0; y < CHUNK_HEIGHT; y++) {
                    const index = this.getIndex(x, y, z);
                    if (y < height - 3) {
                        this.voxels[index] = BLOCK.STONE;
                    } else if (y < height) {
                        this.voxels[index] = BLOCK.DIRT;
                    } else if (y === height) {
                        this.voxels[index] = BLOCK.GRASS;
                    } else {
                        this.voxels[index] = BLOCK.AIR; // Ensure air above terrain
                    }
                }
            }
        }
    }

    // Basic (Inefficient) Mesh Generation - Creates individual cubes
    createMesh() {
        if (this.mesh) {
            scene.remove(this.mesh);
            // Properly dispose of geometry/material if needed
        }

        const geometries = [];
        const material = new THREE.MeshLambertMaterial({ vertexColors: true }); // Use vertex colors for now
        // For textures: new THREE.MeshStandardMaterial({ map: textureAtlas });

        for (let y = 0; y < CHUNK_HEIGHT; y++) {
            for (let z = 0; z < CHUNK_SIZE; z++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const blockType = this.getBlock(x, y, z);
                    if (!BLOCK_SOLID[blockType]) continue; // Skip air

                    // Check neighbors to only draw visible faces (Basic Culling)
                    const faces = {
                        px: !this.isSolid(x + 1, y, z), // Positive X face
                        nx: !this.isSolid(x - 1, y, z), // Negative X face
                        py: !this.isSolid(x, y + 1, z), // Positive Y face
                        ny: !this.isSolid(x, y - 1, z), // Negative Y face
                        pz: !this.isSolid(x, y, z + 1), // Positive Z face
                        nz: !this.isSolid(x, y, z - 1), // Negative Z face
                    };

                    if (Object.values(faces).some(v => v)) { // Only add geometry if at least one face is visible
                        const blockGeo = new THREE.BoxGeometry(VOXEL_SIZE, VOXEL_SIZE, VOXEL_SIZE);
                        const color = new THREE.Color(BLOCK_COLORS[blockType] || 0xffffff);

                        // Apply color to vertices (crude way, better with textures/custom shaders)
                        const colors = [];
                        for(let i = 0; i < blockGeo.attributes.position.count; i++) {
                            colors.push(color.r, color.g, color.b);
                        }
                        blockGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

                        // --- Filter faces ---
                        // This part is COMPLEX. For simple cubes, we'd ideally create a single
                        // geometry per chunk and merge boxes, or better, use Greedy Meshing.
                        // For now, we just add the whole box if any face is visible.

                        const matrix = new THREE.Matrix4().makeTranslation(
                            this.worldX + x * VOXEL_SIZE + VOXEL_SIZE / 2,
                            y * VOXEL_SIZE + VOXEL_SIZE / 2,
                            this.worldZ + z * VOXEL_SIZE + VOXEL_SIZE / 2
                        );
                        blockGeo.applyMatrix4(matrix);
                        geometries.push(blockGeo);
                    }
                }
            }
        }

        if (geometries.length > 0) {
             // !! VERY INEFFICIENT !! Merging many small boxes is slow.
             // Replace this with Greedy Meshing for production.
            const mergedGeometry = BufferGeometryUtils.mergeBufferGeometries(geometries, false);
            this.mesh = new THREE.Mesh(mergedGeometry, material);
            // this.mesh.castShadow = true;
            // this.mesh.receiveShadow = true;
            scene.add(this.mesh);
        } else {
            this.mesh = null; // No geometry to render
        }
         geometries.forEach(geo => geo.dispose()); // Clean up intermediate geometries
    }


    getIndex(x, y, z) {
        if (x < 0 || x >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT || z < 0 || z >= CHUNK_SIZE) {
            return -1; // Out of bounds
        }
        return y * (CHUNK_SIZE * CHUNK_SIZE) + z * CHUNK_SIZE + x;
    }

    getBlock(x, y, z) {
        const localX = x;
        const localY = y;
        const localZ = z;

        if (localX < 0 || localX >= CHUNK_SIZE || localY < 0 || localY >= CHUNK_HEIGHT || localZ < 0 || localZ >= CHUNK_SIZE) {
            // Need to check neighboring chunks
            return getBlockWorld(this.worldX + x, y, this.worldZ + z);
        }
        const index = this.getIndex(localX, localY, localZ);
        return index !== -1 ? this.voxels[index] : BLOCK.AIR;
    }

     setBlock(x, y, z, type) {
        const localX = x;
        const localY = y;
        const localZ = z;

         if (localX < 0 || localX >= CHUNK_SIZE || localY < 0 || localY >= CHUNK_HEIGHT || localZ < 0 || localZ >= CHUNK_SIZE) {
            // Need to modify neighboring chunks
             setBlockWorld(this.worldX + x, y, this.worldZ + z, type);
            return;
        }

        const index = this.getIndex(localX, localY, localZ);
        if (index !== -1) {
            if (this.voxels[index] !== type) { // Only update if changed
                this.voxels[index] = type;
                chunksToUpdate.add(getChunkKey(this.x, this.z)); // Mark this chunk for mesh update

                // Also mark neighbors if the block is on the edge
                if (localX === 0) chunksToUpdate.add(getChunkKey(this.x - 1, this.z));
                if (localX === CHUNK_SIZE - 1) chunksToUpdate.add(getChunkKey(this.x + 1, this.z));
                if (localZ === 0) chunksToUpdate.add(getChunkKey(this.x, this.z - 1));
                if (localZ === CHUNK_SIZE - 1) chunksToUpdate.add(getChunkKey(this.x, this.z + 1));
                 // Note: Updates don't check Y boundaries as chunks are vertically independent here
            }
        }
    }

    // Helper to check if a block is solid (considers neighbors)
    isSolid(x, y, z) {
        const blockType = this.getBlock(x, y, z);
        return BLOCK_SOLID[blockType];
    }
}

function getChunkKey(chunkX, chunkZ) {
    return `${chunkX},${chunkZ}`;
}

function loadInitialChunks() {
    const initialRadius = 2; // Load a smaller area initially
    for (let x = -initialRadius; x <= initialRadius; x++) {
        for (let z = -initialRadius; z <= initialRadius; z++) {
            ensureChunk(x, z);
        }
    }
    // Immediately update meshes for the initial view
    updateDirtyChunks();
}

function ensureChunk(chunkX, chunkZ) {
    const key = getChunkKey(chunkX, chunkZ);
    if (!world[key]) {
        console.log(`Generating chunk: ${key}`);
        const newChunk = new Chunk(chunkX, chunkZ);
        world[key] = newChunk;
        chunksToUpdate.add(key); // Needs initial mesh generation
        return newChunk;
    }
    return world[key];
}

// Load/Unload chunks based on player position
function updateChunksAroundPlayer() {
    const cam = controls.getObject();
    const currentChunkX = Math.floor(cam.position.x / CHUNK_SIZE);
    const currentChunkZ = Math.floor(cam.position.z / CHUNK_SIZE);

    // TODO: Unload distant chunks (iterate `world`, check distance, remove mesh, delete from `world`)

    for (let x = currentChunkX - RENDER_DISTANCE; x <= currentChunkX + RENDER_DISTANCE; x++) {
        for (let z = currentChunkZ - RENDER_DISTANCE; z <= currentChunkZ + RENDER_DISTANCE; z++) {
            ensureChunk(x, z);
        }
    }
}

function updateDirtyChunks() {
     if (chunksToUpdate.size === 0) return;
     // Limit updates per frame to avoid stutter
     let updatedCount = 0;
     const maxUpdatesPerFrame = 4; // Adjust as needed

     const chunksToProcess = Array.from(chunksToUpdate); // Process a snapshot
     chunksToUpdate.clear(); // Clear immediately

    for (const key of chunksToProcess) {
        const chunk = world[key];
        if (chunk) {
            console.log(`Updating mesh for chunk: ${key}`);
            chunk.createMesh(); // Regenerate mesh
            updatedCount++;
            if(updatedCount >= maxUpdatesPerFrame) {
                 // Re-add remaining chunks to be processed next frame
                 chunksToUpdate = new Set([...chunksToUpdate, ...chunksToProcess.slice(updatedCount)]);
                 break;
            }
        }
    }
     console.log(`Updated ${updatedCount} chunk meshes.`);
}


// --- Block Access (World Coordinates) ---
function getBlockWorld(worldX, worldY, worldZ) {
    if (worldY < 0 || worldY >= CHUNK_HEIGHT) return BLOCK.AIR; // Outside vertical bounds

    const chunkX = Math.floor(worldX / CHUNK_SIZE);
    const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
    const chunk = world[getChunkKey(chunkX, chunkZ)];

    if (!chunk) return BLOCK.AIR; // Chunk not loaded (or doesn't exist)

    const localX = worldX - chunk.worldX;
    const localY = worldY;
    const localZ = worldZ - chunk.worldZ;

    return chunk.getBlock(localX, localY, localZ); // Use chunk's internal getter (handles boundary checks if needed)
}

function setBlockWorld(worldX, worldY, worldZ, type) {
    if (worldY < 0 || worldY >= CHUNK_HEIGHT) return;

    const chunkX = Math.floor(worldX / CHUNK_SIZE);
    const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
    const chunk = world[getChunkKey(chunkX, chunkZ)];

    if (!chunk) return; // Cannot set block in non-existent chunk

    const localX = worldX - chunk.worldX;
    const localY = worldY;
    const localZ = worldZ - chunk.worldZ;

    chunk.setBlock(localX, localY, localZ, type);
}

function isSolidWorld(worldX, worldY, worldZ) {
    const blockType = getBlockWorld(worldX, worldY, worldZ);
    return BLOCK_SOLID[blockType];
}


// --- Player Movement & Physics ---
const keys = {};
function onKeyDown(event) { keys[event.code] = true; }
function onKeyUp(event) { keys[event.code] = false; }

// Helper function to get blocks intersecting a bounding box
function getBlocksInBoundingBox(box) {
    const blocks = [];
    const minX = Math.floor(box.min.x);
    const maxX = Math.ceil(box.max.x);
    const minY = Math.floor(box.min.y);
    const maxY = Math.ceil(box.max.y);
    const minZ = Math.floor(box.min.z);
    const maxZ = Math.ceil(box.max.z);

    for (let y = minY; y < maxY; y++) {
        for (let z = minZ; z < maxZ; z++) {
            for (let x = minX; x < maxX; x++) {
                if (isSolidWorld(x, y, z)) {
                    blocks.push({ x, y, z });
                }
            }
        }
    }
    return blocks;
}

// Helper to get the player's current world bounding box
function getPlayerBoundingBox(position) {
    const halfWidth = PLAYER_WIDTH / 2;
    // Player position is eye level, bbox bottom is at position.y - PLAYER_HEIGHT
    return new THREE.Box3(
        new THREE.Vector3(position.x - halfWidth, position.y - PLAYER_HEIGHT, position.z - halfWidth),
        new THREE.Vector3(position.x + halfWidth, position.y, position.z + halfWidth)
    );
}


function handleMovement(deltaTime) {
    const player = controls.getObject();
    const speed = 5; // Base speed, deltaTime applied later
    const epsilon = 0.001; // Small offset to prevent sticking

    // --- Calculate Intended Velocity ---
    const moveForward = (keys['KeyW'] || keys['ArrowUp']) ? 1 : 0;
    const moveBackward = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
    const moveLeft = (keys['KeyA'] || keys['ArrowLeft']) ? 1 : 0;
    const moveRight = (keys['KeyD'] || keys['ArrowRight']) ? 1 : 0;

    const direction = new THREE.Vector3();
    player.getWorldDirection(direction);
    direction.y = 0;
    direction.normalize();

    // Calculate the RIGHT vector using forward x up
    const right = new THREE.Vector3().crossVectors(direction, player.up).normalize(); // Swapped order here

    const horizontalVelocity = new THREE.Vector3();
    if (moveForward || moveBackward || moveLeft || moveRight) { // Only normalize if there's input
        horizontalVelocity.addScaledVector(direction, (moveForward - moveBackward));
        horizontalVelocity.addScaledVector(right, (moveRight - moveLeft)); // Apply movement along the calculated right vector
        horizontalVelocity.normalize().multiplyScalar(speed);
    }

    // Apply gravity
    playerVelocity.y += GRAVITY * deltaTime;

    // Frame's potential displacement vector
    const frameDisplacement = new THREE.Vector3(
        horizontalVelocity.x * deltaTime,
        playerVelocity.y * deltaTime,
        horizontalVelocity.z * deltaTime
    );


    // --- Collision Detection (Axis-by-Axis) ---
    const currentPos = player.position.clone(); // Start with current position
    let correctedPos = currentPos.clone(); // Position after collision adjustments

    onGround = false; // Reset before checks

    // --- Check Y movement ---
    let targetYPos = currentPos.clone().add(new THREE.Vector3(0, frameDisplacement.y, 0));
    let playerBoxY = getPlayerBoundingBox(targetYPos);
    let potentialYBlocks = getBlocksInBoundingBox(playerBoxY);

    for (const block of potentialYBlocks) {
        const blockBox = new THREE.Box3(
            new THREE.Vector3(block.x, block.y, block.z),
            new THREE.Vector3(block.x + 1, block.y + 1, block.z + 1)
        );
        if (playerBoxY.intersectsBox(blockBox)) {
            if (frameDisplacement.y < 0) { // Moving Down
                // Adjust position to be just above the block
                correctedPos.y = block.y + 1 + PLAYER_HEIGHT + epsilon;
                playerVelocity.y = 0;
                onGround = true;
            } else if (frameDisplacement.y > 0) { // Moving Up (Hit ceiling)
                // Adjust position to be just below the block
                 correctedPos.y = block.y - epsilon;
                 playerVelocity.y = 0;
            }
             // Recalculate potential displacement for Y after correction
             frameDisplacement.y = correctedPos.y - currentPos.y;
            break; // Collision resolved for Y axis
        }
    }
    // Apply the potentially corrected Y displacement
    correctedPos.y = currentPos.y + frameDisplacement.y;


    // --- Check X movement ---
    let targetXPos = correctedPos.clone().add(new THREE.Vector3(frameDisplacement.x, 0, 0)); // Use already corrected Y pos
    let playerBoxX = getPlayerBoundingBox(targetXPos);
    let potentialXBlocks = getBlocksInBoundingBox(playerBoxX);

    for (const block of potentialXBlocks) {
        const blockBox = new THREE.Box3(
            new THREE.Vector3(block.x, block.y, block.z),
            new THREE.Vector3(block.x + 1, block.y + 1, block.z + 1)
        );
        if (playerBoxX.intersectsBox(blockBox)) {
             const halfWidth = PLAYER_WIDTH / 2;
             if (frameDisplacement.x > 0) { // Moving Right (+X)
                  correctedPos.x = block.x - halfWidth - epsilon;
             } else if (frameDisplacement.x < 0) { // Moving Left (-X)
                  correctedPos.x = block.x + 1 + halfWidth + epsilon;
             }
             // Recalculate potential displacement for X after correction
             frameDisplacement.x = correctedPos.x - currentPos.x;
             // We don't zero out horizontal velocity here, just prevent penetration
             break; // Collision resolved for X axis
        }
    }
    // Apply the potentially corrected X displacement
    correctedPos.x = currentPos.x + frameDisplacement.x;


    // --- Check Z movement ---
    let targetZPos = correctedPos.clone().add(new THREE.Vector3(0, 0, frameDisplacement.z)); // Use already corrected Y and X pos
    let playerBoxZ = getPlayerBoundingBox(targetZPos);
    let potentialZBlocks = getBlocksInBoundingBox(playerBoxZ);

    for (const block of potentialZBlocks) {
        const blockBox = new THREE.Box3(
            new THREE.Vector3(block.x, block.y, block.z),
            new THREE.Vector3(block.x + 1, block.y + 1, block.z + 1)
        );
        if (playerBoxZ.intersectsBox(blockBox)) {
             const halfWidth = PLAYER_WIDTH / 2;
             if (frameDisplacement.z > 0) { // Moving "Forward" (+Z world)
                 correctedPos.z = block.z - halfWidth - epsilon;
             } else if (frameDisplacement.z < 0) { // Moving "Backward" (-Z world)
                 correctedPos.z = block.z + 1 + halfWidth + epsilon;
             }
            // Recalculate potential displacement for Z after correction
             frameDisplacement.z = correctedPos.z - currentPos.z;
             // We don't zero out horizontal velocity here, just prevent penetration
            break; // Collision resolved for Z axis
        }
    }
     // Apply the potentially corrected Z displacement
     correctedPos.z = currentPos.z + frameDisplacement.z;


    // --- Apply Final Position ---
    player.position.copy(correctedPos); // Update player position with corrected values


    // --- Jumping ---
    if (keys['Space'] && onGround) {
        playerVelocity.y = JUMP_VELOCITY;
        onGround = false; // Immediately set to false after jump impulse
    }

    // Prevent falling through floor
    // if (playerPos.y < -50) { // Note: Using playerPos here might be slightly outdated, should use correctedPos or player.position
    if (player.position.y < -50) { // Use the updated player position
         player.position.y = CHUNK_HEIGHT + 10; // Respawn high up
         playerVelocity.set(0,0,0);
    }
}

// --- Block Interaction ---
function onMouseDown(event) {
    if (!controls.isLocked) return;

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera({ x: 0, y: 0 }, camera); // Ray from center of screen
    const intersects = raycaster.intersectObjects(scene.children.filter(c => c.isMesh)); // Intersect chunk meshes

    if (intersects.length > 0) {
        const intersection = intersects[0];
        if (intersection.distance > REACH_DISTANCE) return; // Too far

        // Calculate block coordinates based on intersection point and face normal
        const point = intersection.point;
        const normal = intersection.face.normal.clone(); // Use face normal from the intersection

        // Tiny epsilon value to push slightly along the normal
        const epsilon = 0.001;

        if (event.button === 0) { // Left Click: Break Block
            // Calculate the position slightly INSIDE the clicked face
            const breakPos = point.clone().addScaledVector(normal, -epsilon).floor();
            console.log("Breaking block at:", breakPos.x, breakPos.y, breakPos.z);
            setBlockWorld(breakPos.x, breakPos.y, breakPos.z, BLOCK.AIR);

        } else if (event.button === 2) { // Right Click: Place Block
            // Calculate the position slightly OUTSIDE the clicked face
            const placePos = point.clone().addScaledVector(normal, epsilon).floor();

            // Check if player is intersecting the placement location
            const playerBB = new THREE.Box3(
                new THREE.Vector3(camera.position.x - PLAYER_WIDTH/2, camera.position.y - PLAYER_HEIGHT, camera.position.z - PLAYER_WIDTH/2),
                new THREE.Vector3(camera.position.x + PLAYER_WIDTH/2, camera.position.y, camera.position.z + PLAYER_WIDTH/2)
            );
            const placeBB = new THREE.Box3(
                new THREE.Vector3(placePos.x, placePos.y, placePos.z),
                new THREE.Vector3(placePos.x + 1, placePos.y + 1, placePos.z + 1)
            );

            if (!playerBB.intersectsBox(placeBB) && getBlockWorld(placePos.x, placePos.y, placePos.z) === BLOCK.AIR) { // Also check ifplacement spot is air
                console.log("Placing block at:", placePos.x, placePos.y, placePos.z);
                setBlockWorld(placePos.x, placePos.y, placePos.z, currentBlockType);
            } else {
                console.log("Cannot place block inside player or in non-air block");
            }
        }
    }
}


// --- Toolbar Selection ---
let selectedToolbarSlot = 0;
const toolbarSlots = document.querySelectorAll('.toolbar-slot');
const blockTypesInToolbar = [BLOCK.DIRT, BLOCK.STONE, BLOCK.WOOD, /*...*/]; // Match HTML

function updateToolbarSelection() {
    toolbarSlots.forEach((slot, index) => {
        if (index === selectedToolbarSlot) {
            slot.classList.add('selected');
            currentBlockType = blockTypesInToolbar[index] || BLOCK.DIRT; // Get block type
        } else {
            slot.classList.remove('selected');
        }
    });
     console.log("Selected Block:", Object.keys(BLOCK).find(key => BLOCK[key] === currentBlockType));
}

function onMouseWheel(event) {
    if (!controls.isLocked) return;
    const delta = Math.sign(event.deltaY);
    selectedToolbarSlot = (selectedToolbarSlot + delta + toolbarSlots.length) % toolbarSlots.length;
    updateToolbarSelection();
}


// --- Window Resize ---
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation Loop ---
function animate() {
    requestAnimationFrame(animate);
    const deltaTime = Math.min(0.05, clock.getDelta()); // Clamp delta to avoid large jumps

    if (controls.isLocked) {
        handleMovement(deltaTime);
        updateChunksAroundPlayer(); // Load/unload chunks based on player movement
    }

    updateDirtyChunks(); // Process chunks needing mesh updates

    renderer.render(scene, camera);
}

// --- Start ---
init();
updateToolbarSelection(); // Initial toolbar setup
