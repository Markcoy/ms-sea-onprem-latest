// Import required modules
const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
const { ObjectId } = require("mongodb");
const bcrypt = require("bcrypt");
const os = require("os");

// Create Express application
const app = express();
dotenv.config();

// Set EJS as the view engine
app.set("view engine", "ejs");

// Define port for the server to listen on
const port = process.env.PORT || 3000;

const server = http.createServer(app);
server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

// WebSocket server setup
const wss = new WebSocket.Server({ server });

// Middleware to parse incoming request bodies
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Serve static files from the 'public' directory
app.use(express.static("public"));

// MongoDB connection string from environment variable
const mongoURI = process.env.MONGO_URI;

// Middleware to log incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log("Request Body:", req.body); // Log request body if it exists
  next(); // Pass control to the next middleware function
});
// Variable to store the latest RFID tag ID received
let latestTagId = "";
app.get("/", async (req, res) => {
  try {
    // Connect to MongoDB
    const client = await connectToDatabase();

    // Access 'evpattendances' and 'evpnotdones' collections in the 'test' database
    const db = client.db("test");
    const collection1 = db.collection("evpattendances");
    const collection2 = db.collection("evpnotdones");

    // Fetch data from 'evpattendances' collection
    const data1 = await collection1.find({}).toArray();

    // Fetch data from 'evpnotdones' collection, excluding documents with stat: "done"
    const data2 = await collection2.find({ stat: { $ne: "done" } }).toArray();

    // Close MongoDB connection
    await closeDatabaseConnection(client);

    // Render the index page with the fetched data
    res.render("index", { data1, data2 });
  } catch (error) {
    // Handle errors
    console.error("Error fetching data from MongoDB:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Route to serve the homepage
app.get("/", (req, res) => {
  res.render("index");
});

// Route to handle incoming RFID data
app.post("/rfid-data", async (req, res) => {
  try {
    // Extract tag ID and time type from the request body
    const tagId = req.body.tagId;
    const timeType = req.body.timeType;

    // Update the latestTagId variable
    latestTagId = tagId;
    const timestamp = new Date();

    // Retrieve user information from the database
    const user = await getUserInfo(tagId);

    // If user not found, send response and return
    if (!user) {
      console.log(`User not found for tag ID: ${tagId}`);
      res.send("User not found");
      return;
    }

    // Log received RFID data and user information
    console.log(
      `Received RFID tag ID: ${tagId} at ${timestamp} for ${timeType}`
    );
    console.log("User Information:", user);

    // Send RFID data to all connected WebSocket clients
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            tagId,
            timestamp,
            timeType,
            user,

            evt_TagId: currentEvent ? currentEvent.evt_TagId : null,
            evt_Title: currentEvent ? currentEvent.evt_Title : null,
            evt_HostOrg: currentEvent ? currentEvent.evt_HostOrg : null,
          })
        );
      }
    });

    // Send success response
    res.send("RFID data received successfully");
  } catch (error) {
    // Handle errors
    console.error("Error handling RFID data:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Define a global variable to store event details
let currentEvent = null;

// Route to handle receiving event tag ID from Arduino
app.post("/receive-event-tag", async (req, res) => {
  try {
    // Extract event tag ID from the request body
    const eventTagId = req.body.eventTagId;

    // Query database to retrieve event information
    const event = await getEventInfo(eventTagId);

    // Set the currentEvent variable to the received event
    currentEvent = event;

    // Send success response
    res.send("Event tag received successfully");
  } catch (error) {
    // Handle errors
    console.error("Error receiving event tag:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Route to handle checking if event tag exists
app.post("/check-event-tag", async (req, res) => {
  let client;
  try {
    // Connect to MongoDB
    client = await connectToDatabase();

    // Access 'events' collection in 'test' database
    const db = client.db("test");
    const eventsCollection = db.collection("events");

    // Check if the event tag ID exists in the collection
    const event = await eventsCollection.findOne({ evt_TagId: req.body.tagId });

    // Set the currentEvent variable to the received event
    currentEvent = event;

    // If the event tag is not found, store it in 'eventtag_notreg' collection
    if (!event) {
      // Check if the event tag ID already exists in the not registered event tags collection
      const notRegisteredClient = await connectToDatabase();
      const notRegisteredDb = notRegisteredClient.db("test");
      const notRegisteredCollection =
        notRegisteredDb.collection("eventtags_notregs");

      // Check if the event tag ID already exists in the collection
      const existingTag = await notRegisteredCollection.findOne({
        eventTagId: req.body.tagId,
      });

      if (!existingTag) {
        // If tag is not already in the collection, insert it
        await notRegisteredCollection.insertOne({
          eventTagId: req.body.tagId,
          timestamp: new Date(),
        });

        // Set timeout to delete the unregistered event tag after one day (24 hours)
        setTimeout(async () => {
          await notRegisteredCollection.deleteOne({
            eventTagId: req.body.tagId,
          });
        }, 24 * 60 * 60 * 1000); // One day (24 hours) timeout
      }

      // Close MongoDB connection
      await closeDatabaseConnection(notRegisteredClient);
    }

    // Send response indicating whether the event tag exists
    if (event) {
      res.send("EXIST");
    } else {
      res.send("NOT_EXIST");
    }
  } catch (error) {
    // Handle errors
    console.error("Error checking event tag:", error);
    res.status(500).send("Internal Server Error");
  } finally {
    if (client) {
      await closeDatabaseConnection(client);
    }
  }
});

async function validateCredentials(username, password) {
  let client;
  try {
    // Connect to MongoDB
    client = await connectToDatabase();

    // Access 'users' collection in the database
    const db = client.db("test");
    const usersCollection = db.collection("users");

    // Find the document with the provided username
    const user = await usersCollection.findOne({ usr_Username: username });

    // If user is found and user type is "admin", compare the hashed password with the provided password
    if (user && user.usr_Type === "Admin") {
      const passwordMatch = await bcrypt.compare(password, user.usr_Password);
      return passwordMatch;
    } else {
      // User not found or user type is not "admin"
      return false;
    }
  } catch (error) {
    // Handle errors
    console.error("Error validating credentials:", error);
    return false;
  } finally {
    if (client) {
      await closeDatabaseConnection(client);
    }
  }
}
// Route to validate credentials
app.post("/api/validate-credentials", async (req, res) => {
  try {
    // Extract username and password from the request body
    const { username, password } = req.body;

    // Check if username and password are provided
    if (!username || !password) {
      return res.status(400).send("Username and password are required");
    }

    // Validate the user's credentials
    const isValidCredentials = await validateCredentials(username, password);

    // If credentials are valid, return success response
    if (isValidCredentials) {
      return res.status(200).json({ isValidCredentials: true });
    } else {
      // If credentials are not valid, return unauthorized response
      return res.status(401).json({ isValidCredentials: false });
    }
  } catch (error) {
    // Handle errors
    console.error("Error validating credentials:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Function to handle time in or time out actions
app.post("/time-action", async (req, res) => {
  try {
    // Extract user tag ID and action type from the request body
    const tagId = req.body.tagId;
    const actionType = req.body.actionType;

    // Retrieve user information from the database
    const user = await getUserInfo(tagId);

    // If user not found, send response and return
    if (!user) {
      console.log(`User not found for tag ID: ${tagId}`);
      res.send("User not found");
      return;
    }

    // Perform the appropriate action based on the action type
    if (actionType === "time-in") {
      // Perform time in action
      // Here you can use the currentEvent variable to associate the event details with the time in action
    } else if (actionType === "time-out") {
      // Perform time out action
      // Here you can use the currentEvent variable to associate the event details with the time out action
    }

    // Send success response
    res.send(`${actionType} action performed successfully`);
  } catch (error) {
    // Handle errors
    console.error("Error performing time action:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Route to handle checking if RFID tag is registered
app.post("/check-tag", async (req, res) => {
  try {
    // Extract tag ID from the request body
    const tagId = req.body.tagId;

    // Check if the tag ID exists in the database
    const user = await getUserInfo(tagId);

    // If user is found, tag is registered; otherwise, tag is not registered
    const isRegistered = !!user;

    // Send response indicating whether the tag is registered
    if (isRegistered) {
      res.json({ registered: true });
    } else {
      // Check if the tag ID already exists in the unregistered tags collection
      const client = new MongoClient(mongoURI);
      await client.connect();

      const db = client.db("test");
      const unregisteredTagsCollection = db.collection("studenttags_notregs");

      // Check if the tag ID already exists in the collection
      const existingTag = await unregisteredTagsCollection.findOne({ tagId });

      if (!existingTag) {
        // If tag is not already in the collection, insert it
        await unregisteredTagsCollection.insertOne({
          tagId,
          timestamp: new Date(),
        });

        // Set timeout to delete the unregistered tag after one day (24 hours)
        setTimeout(async () => {
          await unregisteredTagsCollection.deleteOne({ tagId });
        }, 24 * 60 * 60 * 1000); // 24 hours timeout
      }

      // Close MongoDB connection
      await client.close();

      res.json({ registered: false });
    }
  } catch (error) {
    // Handle errors
    console.error("Error checking RFID tag:", error);
    res.status(500).send("Internal Server Error");
  }
});
// Route to handle deleting a document from the MongoDB database
app.delete("/api/delete-document/:id", async (req, res) => {
  try {
    // Extract the ID of the document to delete from the request parameters
    const documentId = req.params.id;

    // Log the documentId to check its format
    console.log("Document ID:", documentId);

    // Check if documentId is undefined or null
    if (!documentId) {
      return res.status(400).send("Document ID is missing or invalid");
    }

    // Connect to MongoDB
    const client = await connectToDatabase();

    // Access the appropriate collection in the database
    const db = client.db("test");
    const attendanceCollection = db.collection("evpattendances");
    const notDoneCollection = db.collection("evpnotdones");

    // Check if there is a corresponding document in the 'evpnotdones' collection
    const correspondingNotDoneDocument = await notDoneCollection.findOne({
      _id: new ObjectId(documentId),
    });

    // If a corresponding document is found in the 'evpnotdones' collection, delete it
    if (correspondingNotDoneDocument) {
      await notDoneCollection.deleteOne({ _id: new ObjectId(documentId) });
      console.log(
        `Document with ID ${documentId} deleted successfully from evpnotdones`
      );
    }

    // Find the document to delete in the 'evpattendances' collection
    const documentToDelete = await attendanceCollection.findOne({
      _id: new ObjectId(documentId),
    });

    // Check if the document exists in the 'evpattendances' collection
    if (!documentToDelete) {
      return res.status(404).send("Document not found");
    }

    // Delete the document from the 'evpattendances' collection
    await attendanceCollection.deleteOne({ _id: new ObjectId(documentId) });

    // Log success message
    console.log(
      `Document with ID ${documentId} deleted successfully from evpattendances`
    );

    // Send success response
    res.status(200).send("Document deleted successfully");

    // Close MongoDB connection
    await closeDatabaseConnection(client);
  } catch (error) {
    // Handle errors
    console.error("Error deleting document:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Route to handle checking event status
app.post("/check-event-status", async (req, res) => {
  try {
    // Extract event tag ID from the request body
    const eventTagId = req.body.eventTagId;

    // Connect to MongoDB
    const client = new MongoClient(mongoURI);
    await client.connect();

    // Access 'events' collection in 'test' database
    const db = client.db("test");
    const eventsCollection = db.collection("events");

    // Query the database to retrieve the event status based on event tag ID
    const event = await eventsCollection.findOne({ evt_TagId: eventTagId });

    // Close MongoDB connection
    await client.close();

    // If event is found, extract the event status
    // For demonstration purposes, let's assume the event status is stored in evt_RegStatus field
    const eventStatus = event ? event.evt_RegStatus : "Unknown";

    // Send response indicating the event status
    res.send(eventStatus);
  } catch (error) {
    // Handle errors
    console.error("Error checking event status:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Route to handle sending RFID data to the database
app.post("/send-to-database", async (req, res) => {
  try {
    // Extract RFID data from the request body
    const { tagId, timeIn, timeOut, duration } = req.body;

    // Retrieve user information from the database
    const user = await getUserInfo(tagId);

    // If user not found, send response and return
    if (!user) {
      console.log(`User not found for tag ID: ${tagId}`);
      return res.send("User not found");
    }

    // Extract required user information including the _id
    const {
      _id,
      usr_FirstName,
      usr_LastName,
      usr_Course,
      usr_Section,
      usr_StudentNum,
      usr_Type,
    } = user;

    // Check if currentEvent is not null
    if (!currentEvent) {
      console.log("Event information not available");
      return res.status(400).send("Event information not available");
    }

    // Extract event information
    const { evt_TagId, evt_Title, evt_HostOrg } = currentEvent;

    // Connect to MongoDB
    const client = new MongoClient(mongoURI);
    await client.connect();

    // Access 'evpattendances' collection in 'test' database
    const db = client.db("test");
    const attendanceCollection = db.collection("evpattendances");

    // Access 'evpnotdones' collection in 'test' database
    const notDoneCollection = db.collection("evpnotdones");

    // Check if there is existing data in 'evpnotdones' collection with the same tagId and evt_TagId
    const existingNotDoneData = await notDoneCollection.findOne({
      tagId,
      evt_TagId,
    });

    if (existingNotDoneData) {
      // If existing data found, update it with status "done"
      await notDoneCollection.updateOne(
        { tagId, evt_TagId },
        { $set: { stat: "done", timeOut, duration } }
      );
    }

    // Retrieve the event information to get the _id
    const event = await getEventInfo(evt_TagId);

    // Prepare document to insert into the 'evpattendances' collection
    const document = {
      tagId,
      timeIn,
      timeOut,
      duration,
      user_Id: _id, // Rename _id as user_Id
      usr_FirstName,
      usr_LastName,
      usr_Course,
      usr_Section,
      usr_StudentNum,
      usr_Type,
      evt_TagId, // Include event tag ID
      evt_Title, // Include event title
      evt_HostOrg, // Include event host organization
      event_Id: event ? event._id : null, // Include event _id as event_Id
    };

    // Insert document into the 'evpattendances' collection
    await attendanceCollection.insertOne(document);

    // Close MongoDB connection
    await client.close();

    // Log success message
    console.log(
      `RFID tag data sent to database successfully: ${tagId}, ${timeIn}, ${timeOut}, ${duration}`
    );
    console.log("User Information:", user);
    console.log("Event Information:", currentEvent);

    // Send success response
    res.send("RFID tag data sent to database successfully");
  } catch (error) {
    // Handle errors
    console.error("Error sending RFID tag data to database:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Route to handle input of time-in data
app.post("/time-in", async (req, res) => {
  try {
    // Extract necessary data from the request body
    const { tagId, timeIn, timeOut, duration } = req.body;

    // Retrieve user information from the database
    const user = await getUserInfo(tagId);

    // If user not found, send response and return
    if (!user) {
      console.log(`User not found for tag ID: ${tagId}`);
      return res.send("User not found");
    }

    // Extract required user information including the _id
    const {
      _id,
      usr_FirstName,
      usr_LastName,
      usr_Course,
      usr_Section,
      usr_StudentNum,
      usr_Type,
    } = user;

    // Check if currentEvent is not null
    if (!currentEvent) {
      console.log("Event information not available");
      return res.status(400).send("Event information not available");
    }

    // Extract event information
    const { evt_TagId, evt_Title, evt_HostOrg } = currentEvent;

    // Check if the user's time-in data already exists in the 'evpattendances' collection
    const existingData = await checkExistingDataa(
      tagId,
      usr_FirstName,
      usr_LastName,
      usr_Course,
      usr_Section,
      usr_StudentNum,
      usr_Type,
      evt_TagId,
      evt_Title,
      evt_HostOrg
    );

    if (existingData) {
      // If the data already exists, send a response indicating it
      return res
        .status(400)
        .send("Time-in data already exists in the database");
    }

    // Check if the user's time-in data already exists in the 'evpnotdones' collection
    const existingNotDoneData = await checkExistingNotDoneData(
      tagId,
      usr_FirstName,
      usr_LastName,
      usr_Course,
      usr_Section,
      usr_StudentNum,
      usr_Type,
      evt_TagId,
      evt_Title,
      evt_HostOrg
    );

    if (existingNotDoneData) {
      // If the data already exists, send a response indicating it
      return res
        .status(400)
        .send("Time-in data already exists in the not done database");
    }

    // If the data doesn't exist in both collections, store it in the 'evpnotdones' collection
    const client = await connectToDatabase();
    const db = client.db("test");
    const notDoneCollection = db.collection("evpnotdones");

    // Retrieve the event information to get the _id
    const event = await getEventInfo(evt_TagId);

    // Prepare document to insert into the collection
    const document = {
      tagId,
      timeIn,
      timeOut, // Set timeOut to null
      duration, // Set duration to null
      user_Id: _id, // Rename _id as user_Id
      usr_FirstName,
      usr_LastName,
      usr_Course,
      usr_Section,
      usr_StudentNum,
      usr_Type,
      evt_TagId, // Include event tag ID
      evt_Title, // Include event title
      evt_HostOrg, // Include event host organization
      event_Id: event ? event._id : null, // Include event _id as event_Id
    };

    // Insert the document into the collection
    await notDoneCollection.insertOne(document);

    // Close MongoDB connection
    await closeDatabaseConnection(client);

    // Send success response
    res.send("Time-in data stored successfully in the not done database");
  } catch (error) {
    // Handle errors
    console.error("Error storing time-in data:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Function to check if the data already exists in the 'evpattendances' collection
async function checkExistingDataa(
  tagId,
  usr_FirstName,
  usr_LastName,
  usr_Course,
  usr_Section,
  usr_StudentNum,
  usr_Type,
  evt_TagId,
  evt_Title,
  evt_HostOrg
) {
  const client = await connectToDatabase();
  const db = client.db("test");
  const collection = db.collection("evpattendances");

  const existingData = await collection.findOne({
    tagId,
    usr_FirstName,
    usr_LastName,
    usr_Course,
    usr_Section,
    usr_StudentNum,
    usr_Type,
    evt_TagId,
    evt_Title,
    evt_HostOrg,
  });

  await closeDatabaseConnection(client);

  return existingData;
}

// Function to check if the data already exists in the 'evpnotdones' collection
async function checkExistingNotDoneData(
  tagId,
  usr_FirstName,
  usr_LastName,
  usr_Course,
  usr_Section,
  usr_StudentNum,
  usr_Type,
  evt_TagId,
  evt_Title,
  evt_HostOrg
) {
  const client = await connectToDatabase();
  const db = client.db("test");
  const collection = db.collection("evpnotdones");

  const existingData = await collection.findOne({
    tagId,
    usr_FirstName,
    usr_LastName,
    usr_Course,
    usr_Section,
    usr_StudentNum,
    usr_Type,
    evt_TagId,
    evt_Title,
    evt_HostOrg,
  });

  await closeDatabaseConnection(client);

  return existingData;
}

// Function to connect to MongoDB database
async function connectToDatabase() {
  const client = new MongoClient(mongoURI);
  await client.connect();
  console.log("Connected to MongoDB database");
  return client;
}

// Function to close MongoDB database connection
async function closeDatabaseConnection(client) {
  await client.close();
  console.log("Closed MongoDB database connection");
}

// Function to check if the data already exists in the collection
async function checkExistingData(
  tagId,
  usr_FirstName,
  usr_LastName,
  usr_Course,
  usr_Section,
  usr_StudentNum,
  usr_Type,
  evt_TagId,
  evt_Title,
  evt_HostOrg
) {
  const client = new MongoClient(mongoURI);
  await client.connect();

  const db = client.db("test");
  const collection = db.collection("evpattendances");

  const existingData = await collection.findOne({
    tagId,
    usr_FirstName,
    usr_LastName,
    usr_Course,
    usr_Section,
    usr_StudentNum,
    usr_Type,
    evt_TagId,
    evt_Title,
    evt_HostOrg,
  });

  await client.close();

  return existingData;
}

// Function to retrieve event information from the database based on event tag ID
async function getEventInfo(eventTagId) {
  // Connect to MongoDB
  const client = new MongoClient(mongoURI);
  await client.connect();

  // Access 'events' collection in 'test' database
  const db = client.db("test");
  const eventsCollection = db.collection("events");

  // Query database to find event information based on event tag ID
  const event = await eventsCollection.findOne({ evt_TagId: eventTagId });

  // Close MongoDB connection
  await client.close();

  return event;
}

// Endpoint to fetch the IPv4 address
app.get("/get-ip", (req, res) => {
  // Get the IPv4 address of the computer
  const ipv4 = getIPv4Address();
  // Send the IPv4 address as JSON
  res.json({ ipv4 });
});

function getIPv4Address() {
  const interfaces = os.networkInterfaces();
  for (const key in interfaces) {
    for (const iface of interfaces[key]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "Unknown";
}

// Function to retrieve user information from the database based on tag ID
async function getUserInfo(tagId) {
  const client = new MongoClient(mongoURI);
  await client.connect();

  const db = client.db("test");
  const usersCollection = db.collection("users");

  const user = await usersCollection.findOne({ tagId });

  await client.close();

  return user;
}

// WebSocket event handler for new connections
wss.on("connection", (ws) => {
  // Send the latestTagId to the newly connected WebSocket client
  if (latestTagId !== "" && ws.readyState === WebSocket.OPEN) {
    ws.send(latestTagId);
  }
});
