// hyperliquid.js - Wallet connection and Hyperliquid trading integration
// Direct API implementation without external SDK

window.HyperliquidManager = (() => {
  // Configuration
  const CONFIG = {
    BUILDER_ADDRESS: '0x7b4497c1b70de6546b551bdf8f951da53b71b97d',
    BUILDER_FEE_BPS: 50, // 5 basis points in tenths (50 = 5 bps)
    MAX_FEE_RATE: '0.1%',
    POSITION_CLOSE_DELAY_MS: 15000,
    TOP_TOKENS_COUNT: 25,
    USE_TESTNET: false
  };

  // Helper to get correct chain ID based on network
  const getUserSignedChainId = () => CONFIG.USE_TESTNET ? CONFIG.TESTNET_USER_SIGNED_CHAIN_ID : CONFIG.MAINNET_USER_SIGNED_CHAIN_ID;
  const getUserSignedChainIdHex = () => CONFIG.USE_TESTNET ? CONFIG.TESTNET_USER_SIGNED_CHAIN_ID_HEX : CONFIG.MAINNET_USER_SIGNED_CHAIN_ID_HEX;

  // State
  let walletAddress = null;
  let isConnected = false;
  let agentPrivateKey = null;
  let agentWallet = null;

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

      walletAddress = accounts[0].toLowerCase();
      console.log('Wallet connected:', walletAddress);

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

      const assets = meta.universe.map((asset, index) => ({
        name: asset.name,
        index: index,
        szDecimals: asset.szDecimals,
        openInterest: parseFloat(contexts[index]?.openInterest || '0'),
        markPrice: parseFloat(contexts[index]?.markPx || '0'),
        maxLeverage: asset.maxLeverage || 50
      }));

      return assets
        .filter(a => a.openInterest > 0 && a.markPrice > 0)
        .sort((a, b) => b.openInterest - a.openInterest)
        .slice(0, CONFIG.TOP_TOKENS_COUNT);
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
    // Hyperliquid requires prices with max 5 significant figures
    const rounded = parseFloat(price.toPrecision(5));
    return rounded.toString();
  };

  // Format size to proper decimals
  const formatSize = (size, decimals) => {
    const factor = Math.pow(10, decimals);
    const rounded = Math.round(size * factor) / factor;
    return rounded.toString();
  };

  // Sign L1 action with agent wallet (using EIP-712)
  const signL1Action = async (action, nonce) => {
    // For L1 actions (orders), we use the "Exchange" domain with chainId 1337
    const domain = {
      name: 'Exchange',
      version: '1',
      chainId: 1337,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    // Create phantom agent to include source 'a' (API wallet)
    const phantomAgent = {
      source: CONFIG.USE_TESTNET ? 'b' : 'a', // 'a' for mainnet, 'b' for testnet
      connectionId: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['address', 'address'],
          [walletAddress, agentWallet.address.toLowerCase()]
        )
      )
    };

    // Create the action hash using keccak256
    const actionHash = createActionHash(action, nonce, phantomAgent);

    // EIP-712 types for Agent
    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };

    // Sign the typed data
    const signature = await agentWallet._signTypedData(domain, types, phantomAgent);
    const sig = ethers.utils.splitSignature(signature);

    return { r: sig.r, s: sig.s, v: sig.v };
  };

  // Create action hash for signing
  const createActionHash = (action, nonce, agent) => {
    // This is a simplified version - Hyperliquid uses msgpack encoding
    // For now, we'll use a JSON-based approach
    const encoded = ethers.utils.defaultAbiCoder.encode(
      ['string', 'uint64', 'bool'],
      [JSON.stringify(action), nonce, false]
    );
    return ethers.utils.keccak256(encoded);
  };

  // Place order using direct API call
  const placeOrder = async (orderParams) => {
    if (!agentWallet || !isConnected) {
      throw new Error('Not connected');
    }

    const {
      asset,       // asset index
      isBuy,       // true for buy, false for sell
      limitPx,     // price
      sz,          // size
      reduceOnly = false,
      orderType = { limit: { tif: 'Ioc' } }
    } = orderParams;

    const nonce = Date.now();

    // Build order wire format
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

    // Sign with agent wallet
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

  // Open a long position
  const openLongPosition = async (token, collateralUsd = 10) => {
    if (!agentWallet || !isConnected) {
      throw new Error('Not connected');
    }

    try {
      const leverage = Math.min(token.maxLeverage, 20);
      const sizeUsd = collateralUsd * leverage;
      const sizeBase = sizeUsd / token.markPrice;
      const roundedSize = formatSize(sizeBase, token.szDecimals);

      console.log(`Opening LONG: ${token.name}, size: ${roundedSize}, leverage: ${leverage}x`);

      const result = await placeOrder({
        asset: token.index,
        isBuy: true,
        limitPx: token.markPrice * 1.01,
        sz: roundedSize,
        reduceOnly: false,
        orderType: { limit: { tif: 'Ioc' } }
      });

      console.log('Order result:', result);

      return {
        success: result.status === 'ok',
        token: token.name,
        side: 'LONG',
        size: roundedSize,
        leverage: leverage,
        collateral: collateralUsd,
        entryPrice: token.markPrice,
        result: result,
        error: result.response
      };
    } catch (error) {
      console.error('Error opening position:', error);
      return { success: false, error: error.message };
    }
  };

  // Close a position
  const closePosition = async (token, size) => {
    if (!agentWallet || !isConnected) {
      throw new Error('Not connected');
    }

    try {
      const tokens = await getTopTokensByOI();
      const currentToken = tokens.find(t => t.name === token.name);
      const currentPrice = currentToken?.markPrice || token.markPrice;

      const result = await placeOrder({
        asset: token.index,
        isBuy: false,
        limitPx: currentPrice * 0.99,
        sz: formatSize(Math.abs(parseFloat(size)), token.szDecimals),
        reduceOnly: true,
        orderType: { limit: { tif: 'Ioc' } }
      });

      console.log('Close result:', result);

      return {
        success: result.status === 'ok',
        exitPrice: currentPrice,
        result: result
      };
    } catch (error) {
      console.error('Error closing position:', error);
      return { success: false, error: error.message };
    }
  };

  // Execute a PerpPlay trade (open, wait, close)
  const executePerpPlayTrade = async (collateralUsd = 10) => {
    const token = await getRandomTopToken();
    if (!token) {
      return { success: false, error: 'No tokens available' };
    }

    const openResult = await openLongPosition(token, collateralUsd);
    if (!openResult.success) {
      return openResult;
    }

    return {
      success: true,
      token: token,
      openResult: openResult,
      closeAfterMs: CONFIG.POSITION_CLOSE_DELAY_MS
    };
  };

  // Public API
  return {
    isWalletAvailable,
    connectWallet,
    disconnectWallet,
    getTopTokensByOI,
    getRandomTopToken,
    openLongPosition,
    closePosition,
    executePerpPlayTrade,
    placeOrder,
    get isConnected() { return isConnected; },
    get walletAddress() { return walletAddress; },
    CONFIG
  };
})();
