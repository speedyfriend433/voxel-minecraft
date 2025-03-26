import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
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
            const mergedGeometry = THREE.BufferGeometryUtils.mergeGeometries(geometries, false);
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

function handleMovement(deltaTime) {
    const speed = 5 * deltaTime;
    const player = controls.getObject();

    const moveForward = (keys['KeyW'] || keys['ArrowUp']) ? 1 : 0;
    const moveBackward = (keys['KeyS'] || keys['ArrowDown']) ? 1 : 0;
    const moveLeft = (keys['KeyA'] || keys['ArrowLeft']) ? 1 : 0;
    const moveRight = (keys['KeyD'] || keys['ArrowRight']) ? 1 : 0;

    const direction = new THREE.Vector3();
    player.getWorldDirection(direction);
    direction.y = 0; // Move horizontally
    direction.normalize();

    const right = new THREE.Vector3().crossVectors(player.up, direction).normalize();

    const moveDir = new THREE.Vector3();
    moveDir.addScaledVector(direction, (moveForward - moveBackward) * speed);
    moveDir.addScaledVector(right, (moveLeft - moveRight) * speed);

    // --- Basic Collision Detection ---
    // Check potential new position before moving
    const currentPos = player.position;
    const potentialPos = currentPos.clone().add(moveDir);

    // AABB collision (simplified - only checks feet and head corners)
    const checkPositions = [
        // Feet level corners
        new THREE.Vector3(potentialPos.x - PLAYER_WIDTH / 2, currentPos.y - PLAYER_HEIGHT + 0.1, potentialPos.z - PLAYER_WIDTH / 2),
        new THREE.Vector3(potentialPos.x + PLAYER_WIDTH / 2, currentPos.y - PLAYER_HEIGHT + 0.1, potentialPos.z - PLAYER_WIDTH / 2),
        new THREE.Vector3(potentialPos.x - PLAYER_WIDTH / 2, currentPos.y - PLAYER_HEIGHT + 0.1, potentialPos.z + PLAYER_WIDTH / 2),
        new THREE.Vector3(potentialPos.x + PLAYER_WIDTH / 2, currentPos.y - PLAYER_HEIGHT + 0.1, potentialPos.z + PLAYER_WIDTH / 2),
         // Head level corners (just below head)
        new THREE.Vector3(potentialPos.x - PLAYER_WIDTH / 2, currentPos.y - 0.1, potentialPos.z - PLAYER_WIDTH / 2),
        new THREE.Vector3(potentialPos.x + PLAYER_WIDTH / 2, currentPos.y - 0.1, potentialPos.z - PLAYER_WIDTH / 2),
        new THREE.Vector3(potentialPos.x - PLAYER_WIDTH / 2, currentPos.y - 0.1, potentialPos.z + PLAYER_WIDTH / 2),
        new THREE.Vector3(potentialPos.x + PLAYER_WIDTH / 2, currentPos.y - 0.1, potentialPos.z + PLAYER_WIDTH / 2),
    ];

    let canMoveX = true;
    let canMoveZ = true;

    for (const pos of checkPositions) {
        const blockX = Math.floor(pos.x);
        const blockY = Math.floor(pos.y);
        const blockZ = Math.floor(pos.z);
        if (isSolidWorld(blockX, blockY, blockZ)) {
            // Check which axis caused the collision
            if (Math.abs(pos.x - currentPos.x) > Math.abs(currentPos.x - Math.floor(currentPos.x) - 0.5)) canMoveX = false;
            if (Math.abs(pos.z - currentPos.z) > Math.abs(currentPos.z - Math.floor(currentPos.z) - 0.5)) canMoveZ = false;
             if (!canMoveX && !canMoveZ) break; // Both blocked
        }
    }

    if (canMoveX) player.position.x += moveDir.x;
    if (canMoveZ) player.position.z += moveDir.z;


    // --- Gravity & Jumping ---
    playerVelocity.y += GRAVITY * deltaTime;
    player.position.y += playerVelocity.y * deltaTime;

    // Ground check / collision
    const feetY = player.position.y - PLAYER_HEIGHT;
    const headY = player.position.y;
    const groundBlockY = Math.floor(feetY);

    // Check blocks around feet for ground collision
    const feetMinX = Math.floor(player.position.x - PLAYER_WIDTH / 2);
    const feetMaxX = Math.floor(player.position.x + PLAYER_WIDTH / 2);
    const feetMinZ = Math.floor(player.position.z - PLAYER_WIDTH / 2);
    const feetMaxZ = Math.floor(player.position.z + PLAYER_WIDTH / 2);

    onGround = false;
    for (let x = feetMinX; x <= feetMaxX; x++) {
        for (let z = feetMinZ; z <= feetMaxZ; z++) {
             if (isSolidWorld(x, groundBlockY, z)) {
                 if (feetY <= groundBlockY + 1) { // +1 because block top is at y+1
                    player.position.y = groundBlockY + 1 + PLAYER_HEIGHT;
                    playerVelocity.y = 0;
                    onGround = true;
                    break;
                 }
             }
        }
         if (onGround) break;
    }

     // Head collision
     const headBlockY = Math.floor(headY);
     for (let x = feetMinX; x <= feetMaxX; x++) {
        for (let z = feetMinZ; z <= feetMaxZ; z++) {
             if (isSolidWorld(x, headBlockY, z)) {
                 if (headY >= headBlockY) {
                    player.position.y = headBlockY - 0.01; // Push down slightly below ceiling
                    playerVelocity.y = Math.min(0, playerVelocity.y); // Stop upward motion
                    break;
                 }
             }
        }
         if (playerVelocity.y <= 0) break; // Stop checking if moving down
    }


    // Jumping
    if (keys['Space'] && onGround) {
        playerVelocity.y = JUMP_VELOCITY;
        onGround = false;
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
        const normal = intersection.face.normal.clone(); // Use face normal

         // Move slightly into the block face for breaking, or away for placing
         const offset = event.button === 0 ? -0.5 : 0.5;
         const blockPos = point.clone().addScaledVector(normal, offset).floor();
         // Adjust for floating point inaccuracies near edges
         if (normal.x !== 0) blockPos.x = Math.round(point.x + normal.x * offset);
         if (normal.y !== 0) blockPos.y = Math.round(point.y + normal.y * offset);
         if (normal.z !== 0) blockPos.z = Math.round(point.z + normal.z * offset);
         blockPos.floor(); // Ensure integer coords


        if (event.button === 0) { // Left Click: Break Block
             console.log("Breaking block at:", blockPos.x, blockPos.y, blockPos.z);
            setBlockWorld(blockPos.x, blockPos.y, blockPos.z, BLOCK.AIR);
        } else if (event.button === 2) { // Right Click: Place Block
             // Need to get the position *outside* the clicked block face
            const placePos = point.clone().addScaledVector(normal, -0.5).floor(); // Move back from face
             if (normal.x !== 0) placePos.x = Math.round(point.x - normal.x * 0.5);
             if (normal.y !== 0) placePos.y = Math.round(point.y - normal.y * 0.5);
             if (normal.z !== 0) placePos.z = Math.round(point.z - normal.z * 0.5);
             placePos.floor();

             // Check if player is intersecting the placement location
             const playerBB = new THREE.Box3(
                 new THREE.Vector3(camera.position.x - PLAYER_WIDTH/2, camera.position.y - PLAYER_HEIGHT, camera.position.z - PLAYER_WIDTH/2),
                 new THREE.Vector3(camera.position.x + PLAYER_WIDTH/2, camera.position.y, camera.position.z + PLAYER_WIDTH/2)
             );
             const placeBB = new THREE.Box3(
                 new THREE.Vector3(placePos.x, placePos.y, placePos.z),
                 new THREE.Vector3(placePos.x + 1, placePos.y + 1, placePos.z + 1)
             );

             if (!playerBB.intersectsBox(placeBB)) {
                 console.log("Placing block at:", placePos.x, placePos.y, placePos.z);
                 setBlockWorld(placePos.x, placePos.y, placePos.z, currentBlockType);
             } else {
                 console.log("Cannot place block inside player");
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
