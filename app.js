import express from "express";
import { Server } from "socket.io";
import { createServer } from "http";

const app = express();
export const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "https://fs.vercel.app",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 5 * 1024 * 1024 * 1024, // 5GB, matches your client's MAX_FILE_SIZE
});
app.use(express.json());

app.get("/", (req, res) => {
  res.send("wellcome to fast file share page")
});
// Track online users by their UID and socketId
const onlineUsers = {};
const activeRooms = {}; // Structure: { roomId: Set<uid> }

const getUserSocketId = (uid) => onlineUsers[uid]?.socketId || null;

io.on("connection", (socket) => {
  // console.log(`User connected: ${socket.id}`);

  socket.on("new_user", (userData) => {
    if (!userData?.uid || !userData?.name) {
      socket.emit("error", {
        message: "User ID and name are required",
      });
      return;
    }
    onlineUsers[userData.uid] = { ...userData, socketId: socket.id };
    io.emit("update_online_users", Object.values(onlineUsers));
    // console.log(`User registered: ${userData.name} (${userData.uid})`);
  });

  socket.on("send_file", ({ roomId, file }) => {
    if (!roomId || !file) {
      socket.emit("error", { message: "Room ID and file are required" });
      return;
    }

    if (!socket.rooms.has(roomId)) {
      socket.emit("error", { message: "You're not in this room" });
      return;
    }
    if (!file.data || !file.name || !file.size) {
      socket.emit("error", { message: "Invalid file data" });
      return;
    }
    socket.to(roomId).emit("new_file", file);
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

    // Check if the room already has 2 participants
    if (activeRooms[roomId] && activeRooms[roomId].size >= 2) {
      // You might want to handle this differently, e.g., send an error to the joining user
      // or redirect them. For now, we'll prevent joining.
      socket.emit("error", { message: "Room is full. Cannot join." });
      console.warn(`Attempted join on full room ${roomId} by ${user.name}`);
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

    // Notify other users in the room about the new joiner
    socket.to(roomId).emit("connected_user", user);
    console.log(`${user.name} (UID: ${user.uid}) joined room ${roomId}`);

    // If there's another user already in the room, send their info to the new joiner
    // This handles the case where a second user joins an existing room
    if (activeRooms[roomId].size > 1) {
      const otherUid = Array.from(activeRooms[roomId]).find(
        (uid) => uid !== user.uid
      );
      if (otherUid) {
        const otherUser = onlineUsers[otherUid];
        if (otherUser) {
          socket.emit("connected_user", otherUser);
          console.log(
            `Sent info about existing user ${otherUser.name} to new joiner ${user.name} in room ${roomId}`
          );
        }
      }
    }
  });

  // Corrected exit_room logic with callback
  socket.on("exit_room", ({ roomId, user }, callback) => {
    if (!roomId || !user?.uid) {
      if (callback) {
        callback({ success: false, message: "Invalid exit room request" });
      }
      return;
    }

    if (socket.rooms.has(roomId)) {
      socket.leave(roomId);

      if (activeRooms[roomId]) {
        activeRooms[roomId].delete(user.uid);
        console.log(
          `User ${user.name} (UID: ${user.uid}) left room ${roomId} voluntarily.`
        );

        // Notify remaining users in the room that this user has left
        if (activeRooms[roomId].size > 0) {
          socket.to(roomId).emit("user_left", user);
          console.log(
            `Notified remaining user(s) in ${roomId} that ${user.name} left.`
          );
        } else {
          // Room is now empty, clean it up
          delete activeRooms[roomId];
          console.log(
            `Room ${roomId} is now empty and removed after user ${user.name} left.`
          );
        }
      }

      // Clear socket properties for this room
      socket.roomId = null;
      socket.user = null;

      if (callback) {
        callback({ success: true, message: "Successfully left the room." });
      }
    } else {
      console.warn(
        `User ${user.name} tried to leave room ${roomId} but wasn't in it.`
      );
      if (callback) {
        callback({
          success: false,
          message: "You are not currently in this room.",
        });
      }
    }
  });

  // Cleanup on disconnect (e.g., browser tab closed, network error)
  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);

    let disconnectedUserUid = null;
    let disconnectedUserName = "Unknown User"; // Default name

    // Find the user associated with this disconnected socket ID and remove from onlineUsers
    for (const uid in onlineUsers) {
      if (onlineUsers[uid].socketId === socket.id) {
        disconnectedUserUid = uid;
        disconnectedUserName = onlineUsers[uid].name; // Get the user's name
        delete onlineUsers[uid];
        break;
      }
    }

    // Update the list of online users for everyone
    io.emit("update_online_users", Object.values(onlineUsers));

    // If the disconnected user was in a room (check using socket.roomId and user data)
    if (socket.roomId && socket.user) {
      const { roomId, user } = socket;

      // Remove user from the room's participant set
      if (activeRooms[roomId]) {
        activeRooms[roomId].delete(user.uid);
        console.log(
          `User ${user.name} (UID: ${user.uid}) disconnected from room ${roomId}.`
        );
        // Notify other clients in the room that this user has left
        if (activeRooms[roomId].size > 0) {
          socket.to(roomId).emit("user_left", user);
          console.log(
            `Notified remaining user(s) in ${roomId} that ${user.name} disconnected.`
          );
        } else {
          // Room is now empty, clean it up
          delete activeRooms[roomId];
          console.log(
            `Room ${roomId} is now empty and removed after disconnect.`
          );
        }
      }
    }
    // If socket.roomId or socket.user were not set (e.g., user disconnected before joining a room fully)
    // but the user was registered via new_user, we can still attempt to clean up if needed:
    else if (disconnectedUserUid && activeRooms) {
      for (const roomId in activeRooms) {
        if (activeRooms[roomId].has(disconnectedUserUid)) {
          activeRooms[roomId].delete(disconnectedUserUid);
          console.log(
            `Cleaned up disconnected user ${disconnectedUserName} (UID: ${disconnectedUserUid}) from room ${roomId}.`
          );

          if (activeRooms[roomId].size > 0) {
            io.to(roomId).emit("user_left", {
              uid: disconnectedUserUid,
              name: disconnectedUserName,
            });
            console.log(
              `Notified remaining user(s) in ${roomId} that ${disconnectedUserName} left (via disconnect cleanup).`
            );
          } else {
            delete activeRooms[roomId];
            console.log(
              `Room ${roomId} is now empty and removed after disconnect cleanup.`
            );
          }
          break; // Assuming a user is only in one room at a time
        }
      }
    }
  });

  socket.on("error", (err) => {
    console.error(`Socket error for ${socket.id}:`, err);
    socket.emit("error", { message: "An internal server error occurred." });
  });
});
