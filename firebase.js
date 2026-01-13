// firebase.js
// (compat mode; must match the SDK versions above)
firebase.initializeApp({
  apiKey: "AIzaSyCrF0KFuxMPNUJUFg7IkKT94-zidijtpx0",
  authDomain: "motusgames-e5c9b.firebaseapp.com",
  databaseURL: "https://motusgames-e5c9b-default-rtdb.firebaseio.com",
  projectId: "motusgames-e5c9b",
  storageBucket: "motusgames-e5c9b.firebasestorage.app",
  messagingSenderId: "491141289326",
  appId: "1:491141289326:web:5089d54db8b9c30a0e1d7f",
  measurementId: "G-TE11Q7LMDX"
});
window.db = firebase.database();     // expose the database instance