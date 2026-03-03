const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const http = require('http');

// --- SERVER SETUP ---
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Ranked Server is Running OK!');
});

const wss = new WebSocket.Server({ server });

const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`Ranked Relay Server running on port ${port}`);
});
// ---------------------------------------

const rooms = new Map(); 
const disconnectedPlayers = new Map();

wss.on('connection', (ws) => {
    ws.room = null;
    ws.clientId = null;
    ws.name = null;
    console.log("New Connection Attempt...");

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'IDENTIFY') handleIdentify(ws, data.clientId, data.name);
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

function handleIdentify(ws, clientId, name) {
    ws.clientId = clientId;
    ws.name = name;
    console.log(`Client Identified: ${name}`);
    
    if (disconnectedPlayers.has(ws.clientId)) {
        clearTimeout(disconnectedPlayers.get(ws.clientId));
        disconnectedPlayers.delete(ws.clientId);
        console.log(`Cleared disconnect timer for ${name}. Welcome back.`);
    }

    let rejoinKey = null;
    rooms.forEach((room, roomKey) => {
        room.clients.forEach(client => {
            if(client.clientId === clientId){
                rejoinKey = roomKey;
            }
        });
    });

    if(rejoinKey != null){
        handleJoin(ws, rejoinKey)
    }
}

function handleDisconnect(ws) {
    if (!ws.clientId || !ws.room) return;
    
    if (disconnectedPlayers.has(ws.clientId)) {
        clearTimeout(disconnectedPlayers.get(ws.clientId));
    }

    const timeoutId = setTimeout(() => {
        performFullLeave(ws); 
    }, 300000); // 5 min to rejoin

    disconnectedPlayers.set(ws.clientId, timeoutId);

}

function performFullLeave(ws) {
    disconnectedPlayers.delete(ws.clientId);

    if (!ws.room) return;
    const room = rooms.get(ws.room);

    if (room) {
        //remove the disconnected player from the room array
        room.clients = room.clients.filter(c => c.clientId !== ws.clientId);

        if (room.clients.length === 0) {
            rooms.delete(ws.room);
            console.log(`Deleted empty room ${ws.room} after forfeit.`);
        } else {
            handlePlayerChat(ws, {content : "Opponent did not respond for 5 minutes."});
            handlePlayerChat(ws, {content : "!forfeit"});
            setTimeout(() => {
                if (rooms.has(ws.room)) {
                    room.clients.forEach(c => {
                        c.room = null; 
                        c.send(JSON.stringify({ type: 'ROOM_STATE', isRunning: false }));
                        c.send(JSON.stringify({ type: 'CHAT', msg: '§eMatch Room Closed (Forfeit).' }));
                    });
                    rooms.delete(ws.room);
                    console.log(`Room ${ws.room} forcefully closed after forfeit.`);
                }
            }, 5000);
        }
    }

}

function handleJoin(ws, roomId) {
    console.log("HI WHY NO WORK");
    console.log(ws.clientId);
    console.log(roomId);
    if (ws.room && ws.room !== roomId){
        handleLeave(ws);
    }
    if (!rooms.has(roomId)) {
        rooms.set(roomId, { clients: [], bestTime: null, winnerId: null, gameOver: false, matchId: null });
    }
    const room = rooms.get(roomId);
    let clientAlreadyInRoom = false;
    let oldWS;

    room.clients.forEach(client => {
        if (client.clientId === ws.clientId) {
            clientAlreadyInRoom = true;
            oldWS = client;
        }
    });
    console.log("client already in room?");
    console.log(clientAlreadyInRoom);

    if (room.clients.length >= 2 && !clientAlreadyInRoom) {
        ws.send(JSON.stringify({ type: 'CHAT', msg: '§cRoom Full' }));
        return;
    }

    console.log("Hi we got here");
    console.log(JSON.stringify(oldWS));

    if(clientAlreadyInRoom) room.clients = room.clients.filter(thing => thing != oldWS);
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

    let count = 10;
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
            room.clients.forEach(client => {
                client.room = null; // Important: Mark client as "not in a room"
                client.send(JSON.stringify({ type: 'CHAT', msg: '§eMatch Room Closed.' }));
                client.send(JSON.stringify({ type: 'ROOM_STATE', isRunning: false })); 
            });

            rooms.delete(roomKeyToDelete);
            console.log(`Room ${roomKeyToDelete} closed`);
        }
    }, 5000);
}

function handleLeave(ws) {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    
    if (room) {
        // 1. Remove the player who is leaving
        room.clients = room.clients.filter(c => c !== ws);
        
        // 2. If a match is active, leaving = instant forfeit
        if (room.matchId && !room.gameOver) {
            room.gameOver = true; // Lock the room state
            
            // Tell the remaining player what happened
            handlePlayerChat(ws, {content : "Opponent abandoned the match!"});
            handlePlayerChat(ws, {content : "!forfeit"});
            
            // Safety net: Force close the room 5 seconds later
            setTimeout(() => {
                if (rooms.has(ws.room)) {
                    room.clients.forEach(c => {
                        c.room = null; 
                        c.send(JSON.stringify({ type: 'ROOM_STATE', isRunning: false }));
                        c.send(JSON.stringify({ type: 'CHAT', msg: '§eMatch Room Closed.' }));
                    });
                    rooms.delete(ws.room);
                }
            }, 5000);
        } else if (room.clients.length === 0) {
            // 3. If no match was running and the room is empty, delete it
            rooms.delete(ws.room);
        }
    }
    
    // 4. Clear the room from the socket so they can join a new one
    ws.room = null; 
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
    if (!ws.room) return;

    // Broadcast to everyone in the room EXCEPT the sender
    // We pass the sender's ID explicitly so the receiver knows who sent it
    broadcastToRoom(ws, { 
        type: 'PLAYER_CHAT',
        name: ws.name, 
        sender: ws.clientId,
        content: data.content 
    });
}
function formatTime(score) {
    const totalSeconds = score / 100;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60);
    return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

// Periodic Cleanup Task (Every 5 Minutes)
setInterval(() => {
    console.log("🧹 Running Periodic Room Cleanup...");
    
    for (const [id, room] of rooms.entries()) {
        if (room.clients.length === 0) {
            rooms.delete(id);
            console.log(`Deleted empty room: ${id}`);
        }
    }
}, 300000); // 300,000ms = 5 minutes