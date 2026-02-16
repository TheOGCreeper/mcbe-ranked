const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const http = require('http');

// --- REPLIT COMPATIBLE SERVER SETUP ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Ranked Server is Running OK!');
});

const wss = new WebSocket.Server({ server });

// Replit uses process.env.PORT, defaults to 8080 if not found
const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`Ranked Relay Server running on port ${port}`);
});
// ---------------------------------------

const rooms = new Map(); 
const pendingDisconnects = new Map();

wss.on('connection', (ws) => {
    ws.room = null;
    ws.clientId = null;
    console.log("New Connection Attempt...");

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'IDENTIFY') handleIdentify(ws, data.clientId);
            else if (ws.clientId) {
                switch (data.type) {
                    case 'JOIN': handleJoin(ws, data.roomId); break;
                    case 'SPLIT': handleSplit(ws, data); break;
                    case 'TIME_UPDATE': handleTimeUpdate(ws, data.time); break;
                    case 'PLAYER_CHAT': handlePlayerChat(ws, data); break;
                }
            }
        } catch (e) {}
    });
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => handleDisconnect(ws));
});

function handleIdentify(ws, clientId) {
    ws.clientId = clientId;
    console.log(`Client Identified: ${clientId}`);

    if (pendingDisconnects.has(clientId)) {
        const savedState = pendingDisconnects.get(clientId);
        clearTimeout(savedState.timeout);

        const room = rooms.get(savedState.roomId);
        if (room) {
            const index = room.clients.indexOf(savedState.oldWS);
            if (index !== -1) room.clients[index] = ws;
            else room.clients.push(ws);
            ws.room = savedState.roomId;

            // ws.send(JSON.stringify({ type: 'CHAT', msg: `§aRestored Connection!` }));
            // broadcastToRoom(ws, { type: 'CHAT', msg: `§aOpponent Rejoined!` });

            if (room.matchId) {
                ws.send(JSON.stringify({ type: 'ROOM_STATE', isRunning: true, matchId: room.matchId }));
            }
        }
        pendingDisconnects.delete(clientId);
    }
}

function handleDisconnect(ws) {
    if (!ws.clientId || !ws.room) return;

    // Friendly "Paused" message
    // broadcastToRoom(ws, { type: 'CHAT', msg: `§eOpponent Paused (Switching Worlds...)` });

    const timeout = setTimeout(() => {
        performFullLeave(ws); 
        pendingDisconnects.delete(ws.clientId);
    }, 300000); // INCREASED TO 5 MINUTES

    pendingDisconnects.set(ws.clientId, { timeout, roomId: ws.room, oldWS: ws });
}

function performFullLeave(ws) {
    if (!ws.room) return;
    const room = rooms.get(ws.room);

    // Safety: Don't delete if the player actually returned
    const isClientStillHere = room.clients.some(c => c.clientId === ws.clientId && c !== ws);
    if (isClientStillHere) return;

    if (room) {
        room.clients = room.clients.filter(c => c !== ws && c.clientId !== ws.clientId);

        // SILENT CLEANUP (Message Removed)
        // If the player is gone for >5 mins, we just remove them silently.

        if (room.clients.length === 0) rooms.delete(ws.room);
    }
}

function handleJoin(ws, roomId) {
    if (ws.room) handleLeave(ws); 
    if (!rooms.has(roomId)) {
        rooms.set(roomId, { clients: [], bestTime: null, winnerId: null, gameOver: false, matchId: null });
    }
    const room = rooms.get(roomId);

    if (room.clients.length >= 2) {
        ws.send(JSON.stringify({ type: 'CHAT', msg: '§cRoom Full' }));
        return;
    }

    room.clients.push(ws);
    ws.room = roomId;
    console.log(`Client ${ws.clientId} joined Room ${roomId}`);
    ws.send(JSON.stringify({ type: 'CHAT', msg: `§aJoined Room ${roomId}` }));

    if (room.matchId) {
        ws.send(JSON.stringify({ type: 'ROOM_STATE', isRunning: true, matchId: room.matchId }));
    } else {
        ws.send(JSON.stringify({ type: 'ROOM_STATE', isRunning: false }));
    }

    if (room.clients.length === 2 && !room.matchId) {
        startCountdown(roomId);
    } else if (!room.matchId) {
        ws.send(JSON.stringify({ type: 'CHAT', msg: '§7Waiting for opponent...' }));
    }
}

function startCountdown(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    room.matchId = randomUUID().split('-')[0];
    room.bestTime = null; 
    room.winnerId = null;
    room.gameOver = false;

    let count = 3;
    const interval = setInterval(() => {
        if (count > 0) {
            broadcastRaw(room, { type: 'COUNTDOWN', count: count });
            count--;
        } else {
            clearInterval(interval);
            broadcastRaw(room, { type: 'GO', matchId: room.matchId });
        }
    }, 1000);
}

function handleTimeUpdate(ws, time) {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;

    broadcastToRoom(ws, { type: 'OPPONENT_TIME', time: time });

    if (room.gameOver) return;

    if (room.bestTime !== null) {
        if (time > room.bestTime) {
            room.gameOver = true;
            resolveMatch(room, room.winnerId, room.bestTime);
        }
    }
}

function handleSplit(ws, data) {
    data.sender = ws.clientId;
    broadcastToRoom(ws, data);

    if (data.name === "Final Time" && ws.room) {
        const room = rooms.get(ws.room);
        if (room) {
            if (room.bestTime === null) {
                room.bestTime = data.time;
                room.winnerId = ws.clientId;
                room.clients.forEach(client => {
                    if (client.clientId !== room.winnerId) {
                        client.send(JSON.stringify({ type: 'CHAT', msg: `§eOpponent finished in §f${formatTime(data.time)}` }));
                    }
                });
            } else {
                room.gameOver = true;
                if (data.time < room.bestTime) {
                    resolveMatch(room, ws.clientId, data.time); 
                } else {
                    resolveMatch(room, room.winnerId, room.bestTime);
                }
            }
        }
    }
}

function resolveMatch(room, winnerClientId, winningTime) {
    const timeStr = formatTime(winningTime);
    room.clients.forEach(client => {
        if (client.clientId === winnerClientId) {
            client.send(JSON.stringify({ type: 'WIN', time: timeStr }));
        } else {
            client.send(JSON.stringify({ type: 'LOSE', time: timeStr }));
        }
        client.send(JSON.stringify({ type: 'RESET' }));
    });

    // 2. Wait 5 Seconds, then dissolve the room
    setTimeout(() => {

        // Search for the room key to delete it safely
        let roomKeyToDelete = null;
        for (const [key, val] of rooms.entries()) {
            if (val === room) {
                roomKeyToDelete = key;
                break;
            }
        }

        if (roomKeyToDelete) {
            // A. Notify players they are being moved to lobby
            room.clients.forEach(client => {
                client.room = null; // Important: Mark client as "not in a room"
                client.send(JSON.stringify({ type: 'CHAT', msg: '§eMatch Room Closed.' }));
                client.send(JSON.stringify({ type: 'ROOM_STATE', isRunning: false })); 
            });

            // B. Delete the room from memory
            rooms.delete(roomKeyToDelete);
            console.log(`Room ${roomKeyToDelete} closed`);
        }
    }, 5000);
}

function handleLeave(ws) {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (room) {
        room.clients = room.clients.filter(c => c !== ws);
        room.clients.forEach(c => {
            // c.send(JSON.stringify({ type: 'CHAT', msg: '§cOpponent Quit.' }));
        });
        if (room.clients.length === 0) rooms.delete(ws.room);
    }
}

function broadcastToRoom(sender, data) {
    if (!sender.room) return;
    const room = rooms.get(sender.room);
    if (room) room.clients.forEach(c => { if (c !== sender && c.clientId !== sender.clientId) c.send(JSON.stringify(data)); });
}
function broadcastRaw(room, data) {
    const msg = JSON.stringify(data);
    room.clients.forEach(c => c.send(msg));
}
function handlePlayerChat(ws, data) {
    if (!ws.room) return; // Player must be in a room to chat

    // Broadcast to everyone in the room EXCEPT the sender
    // We pass the sender's ID explicitly so the receiver knows who sent it
    broadcastToRoom(ws, { 
        type: 'PLAYER_CHAT', 
        sender: ws.clientId, // This is the manual name (e.g., "Steve")
        content: data.content 
    });
}
function formatTime(score) {
    const totalSeconds = score / 100;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60);
    return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}