# Shut the Box

A fun card & dice game of choice and luck.

## Overview

This is a browser-based implementation of the classic "Shut the Box" dice game. Players roll dice and flip over cards that add up to their roll, trying to "shut" all the cards.

## Project Structure

- `index.html` - Main HTML page
- `style.css` - Styling
- `stb.js` - Core game logic
- `firebase.js` - Firebase integration for stats tracking
- `hyperliquid.js` - Crypto wallet/trading integration for "PerpPlay" mode
- Various `.mp3` files - Sound effects
- `logo.png`, `space2.jpg` - Visual assets

## Running the Project

The project is served as static files using `npx serve -l 5000` on port 5000.

## Features

- Free Play mode - Classic game without wallet connection
- PerpPlay mode - Connect MetaMask/Rabby wallet for Hyperliquid integration
- Keyboard controls (Enter to roll, arrows to select, spacebar to flip)
- Sound effects
- Global stats tracking via Firebase

## External Dependencies

- Firebase (loaded from CDN) - For stats/player tracking
- Ethers.js (loaded from CDN) - For wallet connections
