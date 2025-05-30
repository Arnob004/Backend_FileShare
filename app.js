import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";

const app = express();
export const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "https://file-share-puce-rho.vercel.app",
    methods: ["GET", "POST"],
    credentials: true,
  },
});
app.use(express.json());

// Track online users by their UID and socketId
const onlineUsers = {}; // { uid: { name, photo, socketId } }
// Track active rooms and their participants (UIDs)
const activeRooms = {}; // { roomId: Set<uid> }

// Helper functions
const getUserSocketId = (uid) => onlineUsers[uid]?.socketId || null;

// Socket.IO connection handler
io.on("connection", (socket) => {
  // console.log(`New connection: ${socket.id}`);

  // User management
  socket.on("new_user", (userData) => {
    if (!userData?.uid || !userData?.name) {
      socket.emit("error", {
        message: "User ID and name are required",
      });
      return;
    }
    // Store user data with their current socket ID
    onlineUsers[userData.uid] = { ...userData, socketId: socket.id };
    io.emit("update_online_users", Object.values(onlineUsers));
    console.log(`User registered: ${userData.name} (${userData.uid})`);
  });

  // File sharing functionality
  socket.on("send_file", ({ roomId, file }) => {
    if (!roomId || !file) {
      socket.emit("error", { message: "Room ID and file are required" });
      return;
    }

    if (!socket.rooms.has(roomId)) {
      socket.emit("error", { message: "You're not in this room" });
      return;
    }

    // Validate file data
    if (!file.data || !file.name || !file.size) {
      socket.emit("error", { message: "Invalid file data" });
      return;
    }

    // Broadcast file to other room participants
    socket.to(roomId).emit("new_file", file);
    // console.log(`File shared in room ${roomId}: ${file.name}`);
  });

  // Connection request handling
  socket.on("send_request", ({ to, from, roomId }) => {
    if (!to || !from || !roomId) {
      socket.emit("error", {
        message: "Recipient, sender, and room ID are required",
      });
      return;
    }

    const receiverSocketId = getUserSocketId(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("receive_request", { from, roomId });
      // console.log(`Request sent from ${from.name} to ${to} for room ${roomId}`);
    } else {
      socket.emit("error", { message: "Recipient is offline" });
    }
  });

  socket.on(
    "accept_request",
    ({ to, from, roomId, senderData, receiverData }) => {
      if (!to || !from || !roomId || !senderData || !receiverData) {
        socket.emit("error", {
          message: "All fields are required to accept a request",
        });
        return;
      }
      const receiverSocketId = getUserSocketId(to);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("request_accepted", {
          from,
          roomId,
          senderData,
          receiverData,
        });
        // console.log(`Request accepted from ${from.name} to ${to}`);
      } else {
        socket.emit("error", { message: "Recipient is offline" });
      }
    }
  );

  socket.on("decline_request", ({ to, from }) => {
    if (!to || !from) {
      socket.emit("error", { message: "Recipient and sender are required" });
      return;
    }

    const receiverSocketId = getUserSocketId(to);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("request_declined", from);
      // console.log(`Request declined from ${from.name} to ${to}`);
    } else {
      socket.emit("error", { message: "Recipient is offline" });
    }
  });

  // Room management
  socket.on("join_room", ({ roomId, user, from }) => {
    if (!roomId || !user?.uid || !user?.name) {
      socket.emit("error", { message: "Invalid room join request" });
      return;
    }
    socket.join(roomId);
    socket.roomId = roomId; // Store roomId on the socket for easy access later
    socket.user = user; // Store user data on the socket for easy access later

    // Track active rooms and add participant
    if (!activeRooms[roomId]) {
      activeRooms[roomId] = new Set();
    }
    activeRooms[roomId].add(user.uid);

    // Notify others in the room that a user connected
    // This is for the "connected_user" event on the client
    socket.to(roomId).emit("connected_user", user);
    // console.log(`${user.name} joined room ${roomId}`);

    // Optional: If you want to notify the joining user about existing users in the room
    // You might need to fetch and send the existing user data here.
  });

  socket.on("leave_room", () => {
    if (!socket.roomId || !socket.user) return; // Ensure socket has room and user data
    const { roomId, user } = socket;

    // console.log(`${user.name} is explicitly leaving room ${roomId}`);

    // Remove user from the room's participant set
    if (activeRooms[roomId]) {
      activeRooms[roomId].delete(user.uid);

      // Notify other clients in the room that this user has left
      socket.to(roomId).emit("user_left", user);

      // Check if the room is now empty or has only one participant left
      if (activeRooms[roomId].size === 0) {
        delete activeRooms[roomId]; // Room is empty, remove it
        // console.log(`Room ${roomId} is now empty.`);
      } else if (activeRooms[roomId].size === 1) {
        // Only one person left in the room
        const remainingUid = activeRooms[roomId].values().next().value;
        const remainingUserSocketId = getUserSocketId(remainingUid);

        if (remainingUserSocketId) {
          // Emit a user_left event to the remaining user,
          // so their client-side logic redirects them.
          io.to(remainingUserSocketId).emit("user_left", {
            uid: user.uid, // The UID of the user who just left
            name: user.name, // The name of the user who just left
          });
          // console.log(
          //   `User ${user.name} left. Redirecting remaining user ${remainingUid} from room ${roomId}.`
          // );
        }
        delete activeRooms[roomId]; // Room should be considered closed for new joins
        // console.log(`Room ${roomId} now has only one user, closing the room.`);
      }
    }
    socket.leave(roomId);
    // Clean up socket's room and user data
    socket.roomId = null;
    socket.user = null;
  });

  // Cleanup on disconnect (e.g., browser tab closed, network error)
  socket.on("disconnect", () => {
    // console.log(`Disconnected: ${socket.id}`);

    let disconnectedUser = null;
    let disconnectedUserRoomId = null;

    // Find the user associated with this disconnected socket ID
    for (const uid in onlineUsers) {
      if (onlineUsers[uid].socketId === socket.id) {
        disconnectedUser = onlineUsers[uid];
        delete onlineUsers[uid]; // Remove from online users
        break;
      }
    }

    // If the disconnected user was in a room
    if (socket.roomId && disconnectedUser) {
      disconnectedUserRoomId = socket.roomId;
      const { roomId, user } = socket; // Use the stored socket.roomId and socket.user

      // Remove user from the room's participant set
      if (activeRooms[roomId]) {
        activeRooms[roomId].delete(user.uid);

        // Notify other clients in the room that this user has left
        socket.to(roomId).emit("user_left", user);

        // Check if the room is now empty or has only one participant left
        if (activeRooms[roomId].size === 0) {
          delete activeRooms[roomId]; // Room is empty, remove it
          // console.log(`Room ${roomId} is now empty after disconnect.`);
        } else if (activeRooms[roomId].size === 1) {
          // Only one person left in the room
          const remainingUid = activeRooms[roomId].values().next().value;
          const remainingUserSocketId = getUserSocketId(remainingUid);

          if (remainingUserSocketId) {
            // Emit a user_left event to the remaining user,
            // so their client-side logic redirects them.
            io.to(remainingUserSocketId).emit("user_left", {
              uid: user.uid, // The UID of the user who just disconnected
              name: user.name, // The name of the user who just disconnected
            });
            // console.log(
            //   `User ${user.name} disconnected. Redirecting remaining user ${remainingUid} from room ${roomId}.`
            // );
          }
          delete activeRooms[roomId]; // Room should be considered closed for new joins
          // console.log(
          //   `Room ${roomId} now has only one user after disconnect, closing the room.`
          // );
        }
      }
    }
    io.emit("update_online_users", Object.values(onlineUsers)); // Update online users list
  });
});
