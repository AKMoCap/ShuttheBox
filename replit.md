# Shut the Box

A fun card & dice game of choice and luck.

## Overview

This is a browser-based implementation of the classic "Shut the Box" dice game. Players roll dice and flip over cards that add up to their roll, trying to "shut" all the cards.

## Project Structure

```
/
├── public/                  # Static files served to browser
│   ├── index.html           # Main HTML page
│   ├── style.css            # Styling
│   ├── stb.js               # Core game logic
│   ├── firebase.js          # Firebase integration for stats tracking
│   ├── hyperliquid.js       # Crypto wallet/trading integration for PerpPlay mode
│   ├── nft-card-generator.html  # NFT card preview/generator
│   ├── *.mp3                # Sound effects
│   ├── logo.png, space2.jpg, STB_NFT.png  # Visual assets
│   └── attached_assets/     # Additional assets (Hyperliquid logo)
├── package.json             # Node.js dependencies
└── replit.md                # This file
```

## Running the Project

The project is served as static files from the `public/` folder using `npx serve public -l 5000` on port 5000.

## Deployment

Configured for static deployment with `publicDir: public`.

## Features

- Free Play mode - Classic game without wallet connection
- PerpPlay mode - Connect MetaMask/Rabby wallet for Hyperliquid integration
  - Opens random perpetual positions on card flips
  - Requires agent wallet approval (two signatures)
  - Uses Arbitrum One (chain ID 42161) for mainnet
- Keyboard controls (Enter to roll, arrows to select, spacebar to flip)
- Sound effects
- Global stats tracking via Firebase
- NFT achievement card for winners ("Certified Box Shutter")

## Game Rules

- 12 cards numbered 1-12
- Roll dice and flip cards that sum to your roll
- Win by flipping all 12 cards ("shutting the box")
- Lose when no valid combination exists for your roll
- Minimum rolls to lose: 2
- Maximum rolls to win: 11-12 (depending on dice mode)

## External Dependencies

- Firebase (loaded from CDN) - For stats/player tracking
- Ethers.js (loaded from CDN) - For wallet connections
- Hyperliquid API - For perpetual trading in PerpPlay mode

## Builder Fees

PerpPlay mode uses Hyperliquid builder codes at 5 basis points (0.05%) on notional value, charged on both position open and close.
