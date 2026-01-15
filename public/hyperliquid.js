// hyperliquid.js - Wallet connection and Hyperliquid trading integration
// Direct API implementation without external SDK

window.HyperliquidManager = (() => {
  // Configuration
  const CONFIG = {
    BUILDER_ADDRESS: '0x7b4497c1b70de6546b551bdf8f951da53b71b97d',
    BUILDER_FEE_BPS: 20, // 2 basis points in tenths (20 = 2 bps)
    TAKER_FEE_BPS: 35, // Hyperliquid taker fee ~3.5 bps
    MAX_FEE_RATE: '0.1%',
    TOP_TOKENS_COUNT: 50,
    MIN_OPEN_INTEREST: 5000000, // $5M minimum OI for liquidity
    USE_TESTNET: false,
    STORAGE_KEY: 'perpplay_wallet_data'
  };

  // Helper to calculate trading fees
  const calculateTradeFee = (notionalValue) => {
    // Total fee = taker fee + builder fee per trade
    // Both are in basis points (1 bp = 0.01% = 0.0001)
    const totalFeeBps = CONFIG.TAKER_FEE_BPS + CONFIG.BUILDER_FEE_BPS;
    return notionalValue * (totalFeeBps / 10000);
  };

  // State
  let walletAddress = null;
  let isConnected = false;
  let agentPrivateKey = null;
  let agentWallet = null;
  let gamePositions = []; // Track positions opened during current game

  // ───────── LocalStorage Persistence ─────────
  const saveWalletData = () => {
    if (!walletAddress || !agentPrivateKey) {
      console.log('Cannot save wallet data - missing address or key');
      return;
    }

    const data = {
      walletAddress: walletAddress,
      agentPrivateKey: agentPrivateKey,
      timestamp: Date.now()
    };

    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(data));
      console.log('Wallet data saved to localStorage:', walletAddress);
      // Verify it was saved
      const verify = localStorage.getItem(CONFIG.STORAGE_KEY);
      console.log('Verified saved data exists:', !!verify);
    } catch (error) {
      console.error('Failed to save wallet data:', error);
    }
  };

  const loadWalletData = () => {
    try {
      const stored = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!stored) return null;
      return JSON.parse(stored);
    } catch (error) {
      console.error('Failed to load wallet data:', error);
      return null;
    }
  };

  const clearWalletData = () => {
    try {
      localStorage.removeItem(CONFIG.STORAGE_KEY);
      console.log('Wallet data cleared from localStorage');
    } catch (error) {
      console.error('Failed to clear wallet data:', error);
    }
  };

  // Check if agent is still valid with Hyperliquid
  const verifyAgentApproval = async (userAddress, agentAddress) => {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'extraAgents',
          user: userAddress
        })
      });

      const agents = await response.json();
      console.log('Agent verification response for user', userAddress, ':', agents);

      // If we got an array, check if our agent is in it
      if (Array.isArray(agents)) {
        const found = agents.some(agent => {
          const addressMatch = agent.agentAddress?.toLowerCase() === agentAddress.toLowerCase();
          const nameMatch = agent.agentName === 'PerpPlay';
          if (addressMatch) {
            console.log('Found agent with matching address:', agent.agentAddress, 'name:', agent.agentName);
          }
          return addressMatch && nameMatch;
        });
        if (found) {
          console.log('Agent verified: found in user\'s agent list');
          return true;
        } else {
          console.log('Agent NOT found in user\'s agent list. Agents:', agents.length);
          return false;
        }
      }

      // Empty or unexpected response
      console.log('Agent verification got unexpected response format');
      return false;
    } catch (error) {
      console.error('Error verifying agent:', error);
      return false;
    }
  };

  // Try to reconnect using stored credentials
  const tryReconnect = async () => {
    const stored = loadWalletData();
    if (!stored) {
      console.log('No stored wallet data found');
      return { success: false, reason: 'no_stored_data' };
    }

    console.log('Found stored wallet data, attempting to reconnect...');

    try {
      const ethereum = window.ethereum || window.rabby;
      if (!ethereum) {
        console.log('No wallet extension found');
        return { success: false, reason: 'no_wallet' };
      }

      // Check if wallet is already connected (don't prompt)
      let accounts;
      try {
        accounts = await ethereum.request({ method: 'eth_accounts' });
      } catch (e) {
        return { success: false, reason: 'wallet_locked' };
      }

      if (!accounts || accounts.length === 0) {
        console.log('Wallet not connected or locked');
        return { success: false, reason: 'wallet_locked' };
      }

      const currentAddress = accounts[0].toLowerCase();

      // Verify it's the same wallet that created the agent
      if (currentAddress !== stored.walletAddress.toLowerCase()) {
        console.log('Connected wallet differs from stored wallet');
        clearWalletData(); // Clear since wallet changed
        return { success: false, reason: 'wallet_mismatch' };
      }

      // Restore the agent wallet from stored private key
      const restoredAgentWallet = new ethers.Wallet(stored.agentPrivateKey);
      const agentAddress = restoredAgentWallet.address.toLowerCase();

      // Verify the agent is still approved with Hyperliquid
      console.log('Verifying agent approval with Hyperliquid...');
      const isApproved = await verifyAgentApproval(currentAddress, agentAddress);

      if (!isApproved) {
        console.log('Agent no longer approved, clearing stored data');
        clearWalletData();
        return { success: false, reason: 'agent_expired' };
      }

      // Success! Restore the connection state
      walletAddress = currentAddress;
      agentPrivateKey = stored.agentPrivateKey;
      agentWallet = restoredAgentWallet;
      isConnected = true;

      console.log('Successfully reconnected with stored credentials');
      console.log('Wallet:', walletAddress);
      console.log('Agent:', agentAddress);

      return {
        success: true,
        address: walletAddress,
        restored: true
      };

    } catch (error) {
      console.error('Reconnection error:', error);
      return { success: false, reason: 'error', error: error.message };
    }
  };

  // Arbitrum One network config
  const ARBITRUM_ONE = {
    chainId: '0xa4b1', // 42161 in hex
    chainName: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://arb1.arbitrum.io/rpc'],
    blockExplorerUrls: ['https://arbiscan.io']
  };

  // Switch to Arbitrum One network
  const switchToArbitrum = async (ethereum) => {
    try {
      const currentChainId = await ethereum.request({ method: 'eth_chainId' });
      if (currentChainId === ARBITRUM_ONE.chainId) {
        console.log('Already on Arbitrum One');
        return;
      }

      console.log('Switching to Arbitrum One...');
      try {
        await ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: ARBITRUM_ONE.chainId }]
        });
      } catch (switchError) {
        if (switchError.code === 4902) {
          await ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [ARBITRUM_ONE]
          });
        } else {
          throw switchError;
        }
      }
      console.log('Switched to Arbitrum One');
    } catch (error) {
      throw new Error('Failed to switch to Arbitrum One: ' + error.message);
    }
  };

  // Check if wallet is available
  const isWalletAvailable = () => {
    return typeof window !== 'undefined' && (window.ethereum || window.rabby);
  };

  // Connect wallet
  const connectWallet = async (walletType = 'metamask') => {
    try {
      const ethereum = walletType === 'rabby' && window.rabby ? window.rabby : window.ethereum;

      if (!ethereum) {
        throw new Error('No Rabby or MetaMask wallet detected!');
      }

      console.log('Requesting wallet connection...');

      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts found. Please unlock your wallet.');
      }

      const newWalletAddress = accounts[0].toLowerCase();
      console.log('Wallet connected:', newWalletAddress);

      // ALWAYS clear existing state when explicitly connecting
      // This ensures a fresh start whether it's the same or different wallet
      console.log('Clearing any existing wallet state for fresh connection...');
      clearWalletData();
      agentWallet = null;
      agentPrivateKey = null;
      isConnected = false;
      gamePositions = [];

      walletAddress = newWalletAddress;

      // Ensure we're on Arbitrum One (required for EIP-712 signing)
      await switchToArbitrum(ethereum);

      // Step 1: Create agent wallet and get approval signature
      console.log('=== STEP 1: Creating Agent Wallet ===');
      const agentResult = await createAndApproveAgent(ethereum);
      if (!agentResult.success) {
        throw new Error('Agent wallet approval failed: ' + agentResult.error);
      }
      console.log('Agent wallet created:', agentResult.agentAddress);

      // Step 2: Approve builder fees
      console.log('=== STEP 2: Approving Builder Fees ===');
      const builderResult = await approveBuilderFee(ethereum);
      if (!builderResult.success) {
        console.warn('Builder fee approval failed (non-critical):', builderResult.error);
      } else {
        console.log('Builder fee approved');
      }

      // Store agent wallet for signing orders
      agentWallet = new ethers.Wallet(agentPrivateKey);
      isConnected = true;

      // Save credentials to localStorage for future reconnection
      saveWalletData();

      return {
        success: true,
        address: walletAddress
      };
    } catch (error) {
      console.error('Wallet connection error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  };

  // Create agent wallet and get user approval
  const createAndApproveAgent = async (ethereum) => {
    try {
      const newAgentWallet = ethers.Wallet.createRandom();
      agentPrivateKey = newAgentWallet.privateKey;
      const agentAddress = newAgentWallet.address.toLowerCase();

      const nonce = Date.now();

      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          'HyperliquidTransaction:ApproveAgent': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'agentAddress', type: 'address' },
            { name: 'agentName', type: 'string' },
            { name: 'nonce', type: 'uint64' }
          ]
        },
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 42161,
          verifyingContract: '0x0000000000000000000000000000000000000000'
        },
        message: {
          hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
          agentAddress: agentAddress,
          agentName: 'PerpPlay',
          nonce: nonce
        }
      };

      console.log('Requesting agent approval signature...');

      const signature = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [walletAddress, JSON.stringify(typedData)]
      });

      const sig = ethers.utils.splitSignature(signature);

      const response = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: {
            type: 'approveAgent',
            hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
            signatureChainId: '0xa4b1',
            agentAddress: agentAddress,
            agentName: 'PerpPlay',
            nonce: nonce
          },
          nonce: nonce,
          signature: { r: sig.r, s: sig.s, v: sig.v },
          vaultAddress: null
        })
      });

      const result = await response.json();
      console.log('Agent approval response:', result);

      if (result.status === 'ok') {
        // Wait for agent to propagate on Hyperliquid's side
        console.log('Waiting for agent registration to propagate...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify the agent is now registered
        const isRegistered = await verifyAgentApproval(walletAddress, agentAddress);
        if (!isRegistered) {
          console.warn('Agent verification failed after approval - may need more time to propagate');
        } else {
          console.log('Agent verified successfully');
        }

        return { success: true, agentAddress: agentAddress };
      } else {
        return { success: false, error: result.response || 'Unknown error' };
      }
    } catch (error) {
      console.error('Agent approval error:', error);
      return { success: false, error: error.message };
    }
  };

  // Approve builder fee
  const approveBuilderFee = async (ethereum) => {
    try {
      const nonce = Date.now();

      const typedData = {
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' },
            { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' },
            { name: 'verifyingContract', type: 'address' }
          ],
          'HyperliquidTransaction:ApproveBuilderFee': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'maxFeeRate', type: 'string' },
            { name: 'builder', type: 'address' },
            { name: 'nonce', type: 'uint64' }
          ]
        },
        primaryType: 'HyperliquidTransaction:ApproveBuilderFee',
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: 42161,
          verifyingContract: '0x0000000000000000000000000000000000000000'
        },
        message: {
          hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
          maxFeeRate: CONFIG.MAX_FEE_RATE,
          builder: CONFIG.BUILDER_ADDRESS,
          nonce: nonce
        }
      };

      console.log('Requesting builder fee approval signature...');

      const signature = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [walletAddress, JSON.stringify(typedData)]
      });

      const sig = ethers.utils.splitSignature(signature);

      const response = await fetch('https://api.hyperliquid.xyz/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: {
            type: 'approveBuilderFee',
            hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
            signatureChainId: '0xa4b1',
            maxFeeRate: CONFIG.MAX_FEE_RATE,
            builder: CONFIG.BUILDER_ADDRESS,
            nonce: nonce
          },
          nonce: nonce,
          signature: { r: sig.r, s: sig.s, v: sig.v },
          vaultAddress: null
        })
      });

      const result = await response.json();
      console.log('Builder fee approval response:', result);

      return { success: result.status === 'ok', error: result.response };
    } catch (error) {
      console.error('Builder fee approval error:', error);
      return { success: false, error: error.message };
    }
  };

  // Disconnect wallet
  const disconnectWallet = () => {
    agentWallet = null;
    walletAddress = null;
    isConnected = false;
    agentPrivateKey = null;
    gamePositions = [];

    // Clear stored credentials
    clearWalletData();

    console.log('Wallet disconnected');
  };

  // Get top tokens by open interest
  const getTopTokensByOI = async () => {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' })
      });

      const data = await response.json();
      const meta = data[0];
      const contexts = data[1];

      const assets = meta.universe.map((asset, index) => {
        const markPrice = parseFloat(contexts[index]?.markPx || '0');
        const openInterestCoins = parseFloat(contexts[index]?.openInterest || '0');
        // Convert OI from coins to USD
        const openInterestUsd = openInterestCoins * markPrice;

        return {
          name: asset.name,
          index: index,
          szDecimals: asset.szDecimals,
          openInterest: openInterestUsd,
          openInterestCoins: openInterestCoins,
          markPrice: markPrice,
          maxLeverage: asset.maxLeverage || 50
        };
      });

      // Filter for liquid perp markets only (minimum $5M OI in USD)
      const filtered = assets
        .filter(a => a.openInterest >= CONFIG.MIN_OPEN_INTEREST && a.markPrice > 0)
        .sort((a, b) => b.openInterest - a.openInterest)
        .slice(0, CONFIG.TOP_TOKENS_COUNT);

      console.log(`Token filter: ${filtered.length} tokens with >$${CONFIG.MIN_OPEN_INTEREST / 1000000}M OI`);
      if (filtered.length > 0) {
        console.log('Top 5:', filtered.slice(0, 5).map(t => `${t.name}: $${(t.openInterest / 1000000).toFixed(1)}M`));
      }

      return filtered;
    } catch (error) {
      console.error('Error fetching tokens:', error);
      return [];
    }
  };

  // Get random top token
  const getRandomTopToken = async () => {
    const tokens = await getTopTokensByOI();
    if (tokens.length === 0) return null;
    return tokens[Math.floor(Math.random() * tokens.length)];
  };

  // Format price to proper string format
  const formatPrice = (price, isRound = false) => {
    const rounded = parseFloat(price.toPrecision(5));
    return rounded.toString();
  };

  // Format size to proper decimals
  const formatSize = (size, decimals) => {
    const factor = Math.pow(10, decimals);
    const rounded = Math.round(size * factor) / factor;
    return rounded.toString();
  };

  // Encode action using msgpack (Hyperliquid format)
  const msgpackEncodeAction = (action) => {
    const encoded = MessagePack.encode(action);
    return encoded;
  };

  // Compute action hash using msgpack encoding
  const computeActionHash = (action, vaultAddress, nonce) => {
    const actionBytes = msgpackEncodeAction(action);
    const nonceBytes = new Uint8Array(8);
    const view = new DataView(nonceBytes.buffer);
    view.setBigUint64(0, BigInt(nonce), false);
    const vaultFlag = new Uint8Array([0]);
    const combined = new Uint8Array(actionBytes.length + nonceBytes.length + vaultFlag.length);
    combined.set(actionBytes, 0);
    combined.set(nonceBytes, actionBytes.length);
    combined.set(vaultFlag, actionBytes.length + nonceBytes.length);
    return ethers.utils.keccak256(combined);
  };

  // Sign L1 action with agent wallet (using EIP-712)
  const signL1Action = async (action, nonce, vaultAddress = null) => {
    const actionHash = computeActionHash(action, vaultAddress, nonce);
    console.log('Action hash:', actionHash);

    const domain = {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    const phantomAgent = {
      source: CONFIG.USE_TESTNET ? 'b' : 'a',
      connectionId: actionHash
    };

    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };

    const signature = await agentWallet._signTypedData(domain, types, phantomAgent);
    const sig = ethers.utils.splitSignature(signature);
    return { r: sig.r, s: sig.s, v: sig.v };
  };

  // Place order using direct API call
  const placeOrder = async (orderParams) => {
    if (!agentWallet || !isConnected) {
      throw new Error('Not connected');
    }

    const {
      asset,
      isBuy,
      limitPx,
      sz,
      reduceOnly = false,
      orderType = { limit: { tif: 'Ioc' } }
    } = orderParams;

    const nonce = Date.now();

    const order = {
      a: asset,
      b: isBuy,
      p: formatPrice(limitPx),
      s: sz,
      r: reduceOnly,
      t: orderType
    };

    const action = {
      type: 'order',
      orders: [order],
      grouping: 'na',
      builder: {
        b: CONFIG.BUILDER_ADDRESS,
        f: CONFIG.BUILDER_FEE_BPS
      }
    };

    console.log('Placing order:', action);
    const signature = await signL1Action(action, nonce);

    const response = await fetch('https://api.hyperliquid.xyz/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: action,
        nonce: nonce,
        signature: signature,
        vaultAddress: null
      })
    });

    const responseText = await response.text();
    console.log('Order response:', responseText);

    try {
      return JSON.parse(responseText);
    } catch (e) {
      return { status: 'error', response: responseText };
    }
  };

  // Update leverage for an asset
  const updateLeverage = async (asset, leverage, isCross = true) => {
    if (!agentWallet || !isConnected) {
      throw new Error('Not connected');
    }

    const nonce = Date.now();

    const action = {
      type: 'updateLeverage',
      asset: asset,
      isCross: isCross,
      leverage: leverage
    };

    console.log('Updating leverage:', action);
    const signature = await signL1Action(action, nonce);

    const response = await fetch('https://api.hyperliquid.xyz/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: action,
        nonce: nonce,
        signature: signature,
        vaultAddress: null
      })
    });

    const responseText = await response.text();
    console.log('Leverage update response:', responseText);

    try {
      return JSON.parse(responseText);
    } catch (e) {
      return { status: 'error', response: responseText };
    }
  };

  // Open a position (Long or Short)
  const openPosition = async (token, collateralUsd = 10, side = 'LONG') => {
    if (!agentWallet || !isConnected) {
      throw new Error('Not connected');
    }

    try {
      const isBuy = side === 'LONG';
      const leverage = Math.min(token.maxLeverage, 20);
      const sizeUsd = collateralUsd * leverage;
      const sizeBase = sizeUsd / token.markPrice;
      const roundedSize = formatSize(sizeBase, token.szDecimals);

      // For shorts, sell to open. For longs, buy to open.
      // Slippage: longs pay higher, shorts pay lower
      const slippageMultiplier = isBuy ? 1.01 : 0.99;

      console.log(`Opening ${side}: ${token.name}, size: ${roundedSize}, leverage: ${leverage}x, wallet: ${walletAddress}`);

      // Verify agent is still valid before trading
      if (agentWallet) {
        console.log('Using agent wallet:', agentWallet.address);
      } else {
        console.error('No agent wallet available!');
        return { success: false, error: 'No agent wallet - please reconnect' };
      }

      // Set leverage before opening position
      const leverageResult = await updateLeverage(token.index, leverage, true);
      console.log('Leverage set result:', leverageResult);

      if (leverageResult.status !== 'ok') {
        console.error('Leverage update failed:', leverageResult);
        // Continue anyway - leverage might already be set correctly
      }

      const result = await placeOrder({
        asset: token.index,
        isBuy: isBuy,
        limitPx: token.markPrice * slippageMultiplier,
        sz: roundedSize,
        reduceOnly: false,
        orderType: { limit: { tif: 'Ioc' } }
      });

      console.log('Order result:', result);

      // Check for specific error conditions
      if (result.status === 'err') {
        const errorMsg = result.response || 'Unknown error';
        console.error('Order error:', errorMsg);

        // Check for agent-related errors
        if (errorMsg.includes('agent') || errorMsg.includes('Agent') || errorMsg.includes('unauthorized')) {
          console.error('Agent authorization error - agent may not be properly registered for this wallet');
          return { success: false, error: 'Agent not authorized. Please disconnect and reconnect your wallet.' };
        }

        return { success: false, error: errorMsg };
      }

      if (result.status === 'ok') {
        // Track this position for the game
        const position = {
          id: Date.now(),
          token: token,
          tokenName: token.name,
          side: side,
          size: parseFloat(roundedSize),
          leverage: leverage,
          collateral: collateralUsd,
          entryPrice: token.markPrice,
          openTime: Date.now()
        };
        gamePositions.push(position);

        return {
          success: true,
          position: position,
          result: result
        };
      } else {
        return {
          success: false,
          error: result.response || 'Order failed'
        };
      }
    } catch (error) {
      console.error('Error opening position:', error);
      return { success: false, error: error.message };
    }
  };

  // Close a specific position
  const closePosition = async (position) => {
    if (!agentWallet || !isConnected) {
      throw new Error('Not connected');
    }

    try {
      // Get current price
      const tokens = await getTopTokensByOI();
      const currentToken = tokens.find(t => t.name === position.tokenName);
      const currentPrice = currentToken?.markPrice || position.entryPrice;

      // To close: sell if long, buy if short
      const isBuy = position.side === 'SHORT';
      const slippageMultiplier = isBuy ? 1.01 : 0.99;

      const result = await placeOrder({
        asset: position.token.index,
        isBuy: isBuy,
        limitPx: currentPrice * slippageMultiplier,
        sz: formatSize(Math.abs(position.size), position.token.szDecimals),
        reduceOnly: true,
        orderType: { limit: { tif: 'Ioc' } }
      });

      console.log('Close result:', result);

      // Calculate PnL (matches Hyperliquid - fees are implicit in fill price)
      const priceDiff = currentPrice - position.entryPrice;
      const pnlUsd = position.side === 'LONG'
        ? priceDiff * position.size
        : -priceDiff * position.size;

      const pnlPercent = (pnlUsd / position.collateral) * 100;

      console.log(`Position closed: P&L $${pnlUsd.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);

      // Remove from game positions
      gamePositions = gamePositions.filter(p => p.id !== position.id);

      return {
        success: result.status === 'ok',
        exitPrice: currentPrice,
        pnlUsd: pnlUsd,
        pnlPercent: pnlPercent,
        result: result
      };
    } catch (error) {
      console.error('Error closing position:', error);
      return { success: false, error: error.message };
    }
  };

  // Close all game positions
  const closeAllPositions = async (onProgress) => {
    const results = [];
    let totalPnl = 0;

    // IMPORTANT: Make a copy of the array since closePosition modifies gamePositions
    const positionsToClose = [...gamePositions];
    const totalPositions = positionsToClose.length;

    for (let i = 0; i < positionsToClose.length; i++) {
      const position = positionsToClose[i];
      if (onProgress) {
        onProgress({
          phase: 'closing',
          current: i + 1,
          total: totalPositions,
          token: position.tokenName
        });
      }

      const result = await closePosition(position);
      results.push({
        token: position.tokenName,
        side: position.side,
        pnlUsd: result.pnlUsd || 0,
        success: result.success
      });
      totalPnl += result.pnlUsd || 0;

      // Small delay between closes to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    gamePositions = [];

    if (onProgress) {
      onProgress({
        phase: 'complete',
        totalPnl: totalPnl,
        results: results
      });
    }

    return { totalPnl, results };
  };

  // Get user's current positions from Hyperliquid API
  const getUserPositions = async () => {
    if (!walletAddress) return [];

    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'clearinghouseState',
          user: walletAddress
        })
      });

      const data = await response.json();
      return data.assetPositions || [];
    } catch (error) {
      console.error('Error fetching user positions:', error);
      return [];
    }
  };

  // Get user's available USDC balance (withdrawable/available for trading)
  const getUserBalance = async () => {
    if (!walletAddress) return null;

    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'clearinghouseState',
          user: walletAddress
        })
      });

      const data = await response.json();
      console.log('Balance API response:', data);

      // withdrawable is the available balance for new positions
      const withdrawable = parseFloat(data.withdrawable || '0');
      // accountValue is total equity
      const accountValue = parseFloat(data.marginSummary?.accountValue || '0');
      // crossMarginSummary might have the balance for cross margin accounts
      const crossAccountValue = parseFloat(data.crossMarginSummary?.accountValue || '0');

      // Use the higher of accountValue or crossAccountValue
      const totalValue = Math.max(accountValue, crossAccountValue);
      // For available balance, use withdrawable, but if it's 0 and we have account value,
      // it might be a display issue - fall back to accountValue
      const available = withdrawable > 0 ? withdrawable : totalValue;

      console.log('Balance parsed:', { withdrawable, accountValue, crossAccountValue, available });

      return {
        available: available,
        accountValue: totalValue
      };
    } catch (error) {
      console.error('Error fetching user balance:', error);
      return null;
    }
  };

  // Get live P&L for game positions (synced with Hyperliquid)
  const getGamePositionsWithPnL = async () => {
    if (gamePositions.length === 0) return [];

    try {
      // Get current prices
      const tokens = await getTopTokensByOI();

      // Get actual positions from Hyperliquid to sync
      const actualPositions = await getUserPositions();

      // Filter out game positions that no longer exist on Hyperliquid
      const stillOpenPositions = gamePositions.filter(pos => {
        // Find matching position on Hyperliquid by token name
        const hlPosition = actualPositions.find(ap => {
          const coin = ap.position?.coin;
          const szi = parseFloat(ap.position?.szi || 0);
          // Match by token name and check if position still has size
          // szi > 0 means long, szi < 0 means short
          const hlSide = szi > 0 ? 'LONG' : 'SHORT';
          return coin === pos.tokenName && Math.abs(szi) > 0;
        });
        return hlPosition !== undefined;
      });

      // Update gamePositions if any were removed
      if (stillOpenPositions.length !== gamePositions.length) {
        const removedCount = gamePositions.length - stillOpenPositions.length;
        console.log(`Synced: ${removedCount} position(s) closed externally`);
        gamePositions = stillOpenPositions;
      }

      return gamePositions.map(pos => {
        const currentToken = tokens.find(t => t.name === pos.tokenName);
        const currentPrice = currentToken?.markPrice || pos.entryPrice;

        const priceDiff = currentPrice - pos.entryPrice;
        const rawPnl = pos.side === 'LONG'
          ? priceDiff * pos.size
          : -priceDiff * pos.size;

        // Don't deduct fees from unrealized P&L - matches Hyperliquid display
        // Fees are already reflected in the fill price difference
        const pnlUsd = rawPnl;
        const pnlPercent = (pnlUsd / pos.collateral) * 100;

        return {
          ...pos,
          currentPrice: currentPrice,
          pnlUsd: pnlUsd,
          pnlPercent: pnlPercent
        };
      });
    } catch (error) {
      console.error('Error calculating PnL:', error);
      return gamePositions;
    }
  };

  // Open a random position (called when card is flipped)
  const openRandomPosition = async (collateralUsd = 10) => {
    const token = await getRandomTopToken();
    if (!token) {
      return { success: false, error: 'No tokens available' };
    }

    // Random side: 75% Long, 25% Short
    const side = Math.random() < 0.75 ? 'LONG' : 'SHORT';

    return openPosition(token, collateralUsd, side);
  };

  // Clear game positions (for new game)
  const clearGamePositions = () => {
    gamePositions = [];
  };

  // Get current game positions count
  const getGamePositionsCount = () => {
    return gamePositions.length;
  };

  // Public API
  return {
    isWalletAvailable,
    connectWallet,
    disconnectWallet,
    tryReconnect,
    getTopTokensByOI,
    getRandomTopToken,
    openPosition,
    openRandomPosition,
    closePosition,
    closeAllPositions,
    getUserPositions,
    getUserBalance,
    getGamePositionsWithPnL,
    clearGamePositions,
    getGamePositionsCount,
    placeOrder,
    get isConnected() { return isConnected; },
    get walletAddress() { return walletAddress; },
    get gamePositions() { return gamePositions; },
    CONFIG
  };
})();
