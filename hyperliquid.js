// hyperliquid.js - Wallet connection and Hyperliquid trading integration

const HyperliquidManager = (() => {
  // Configuration
  const CONFIG = {
    MAINNET_API: 'https://api.hyperliquid.xyz',
    TESTNET_API: 'https://api.hyperliquid-testnet.xyz',
    // For user-signed actions (approveAgent, approveBuilderFee), use 421614
    USER_SIGNED_CHAIN_ID: 421614, // 0x66eee - Hyperliquid user-signed actions
    USER_SIGNED_CHAIN_ID_HEX: '0x66eee',
    // For L1 actions (orders), use Arbitrum
    L1_CHAIN_ID: 42161, // Arbitrum mainnet
    L1_CHAIN_ID_HEX: '0xa4b1',
    BUILDER_ADDRESS: '0x7B4497c1B70dE6546B551Bdf8f951Da53B71b97d',
    BUILDER_FEE_BPS: 5, // 5 basis points = 0.05%
    LEVERAGE: 20,
    POSITION_CLOSE_DELAY_MS: 15000, // 15 seconds
    TOP_TOKENS_COUNT: 25,
    USE_TESTNET: false // Set to true for testing
  };

  // State
  let provider = null;
  let signer = null;
  let walletAddress = null;
  let isConnected = false;
  let agentWallet = null;
  let agentPrivateKey = null;
  let assetMeta = null;
  let assetContexts = null;

  // Get API URL based on network
  const getApiUrl = () => CONFIG.USE_TESTNET ? CONFIG.TESTNET_API : CONFIG.MAINNET_API;

  // Check if wallet is available
  const isWalletAvailable = () => {
    return typeof window !== 'undefined' && (window.ethereum || window.rabby);
  };

  // Connect wallet (MetaMask or Rabby)
  const connectWallet = async (walletType = 'metamask') => {
    try {
      let ethereum;

      if (walletType === 'rabby' && window.rabby) {
        ethereum = window.rabby;
      } else if (window.ethereum) {
        ethereum = window.ethereum;
      } else {
        throw new Error('No Web3 wallet detected. Please install MetaMask or Rabby.');
      }

      console.log('Requesting wallet connection...');

      // Request account access
      const accounts = await ethereum.request({ method: 'eth_requestAccounts' });

      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts found. Please unlock your wallet.');
      }

      // Create ethers provider and signer
      provider = new ethers.providers.Web3Provider(ethereum);
      signer = provider.getSigner();
      walletAddress = await signer.getAddress();
      isConnected = true;

      console.log('Wallet connected:', walletAddress);

      // Fetch asset metadata first
      console.log('Fetching asset metadata...');
      await fetchAssetMeta();

      // Setup agent wallet and request approvals
      console.log('Setting up agent wallet...');
      const agentSetupSuccess = await setupAgentWallet();

      if (!agentSetupSuccess) {
        console.warn('Agent wallet setup incomplete - trading may not work');
      }

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

  // Disconnect wallet
  const disconnectWallet = () => {
    provider = null;
    signer = null;
    walletAddress = null;
    isConnected = false;
    agentWallet = null;
    agentPrivateKey = null;
    console.log('Wallet disconnected');
  };

  // Fetch asset metadata and contexts from Hyperliquid
  const fetchAssetMeta = async () => {
    try {
      const response = await fetch(getApiUrl() + '/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' })
      });

      if (!response.ok) {
        throw new Error('Failed to fetch asset metadata');
      }

      const data = await response.json();
      assetMeta = data[0]; // Universe metadata
      assetContexts = data[1]; // Asset contexts with prices, OI, etc.

      console.log('Asset metadata loaded:', assetMeta.universe.length, 'assets');
      return true;
    } catch (error) {
      console.error('Error fetching asset meta:', error);
      return false;
    }
  };

  // Get top tokens by open interest
  const getTopTokensByOI = () => {
    if (!assetMeta || !assetContexts) {
      console.error('Asset data not loaded');
      return [];
    }

    // Combine universe info with contexts
    const assetsWithOI = assetMeta.universe.map((asset, index) => {
      const context = assetContexts[index];
      return {
        name: asset.name,
        index: index,
        szDecimals: asset.szDecimals,
        openInterest: parseFloat(context.openInterest || '0'),
        markPrice: parseFloat(context.markPx || '0'),
        maxLeverage: asset.maxLeverage || 50
      };
    });

    // Sort by open interest descending and take top N
    const topTokens = assetsWithOI
      .filter(a => a.openInterest > 0 && a.markPrice > 0)
      .sort((a, b) => b.openInterest - a.openInterest)
      .slice(0, CONFIG.TOP_TOKENS_COUNT);

    return topTokens;
  };

  // Get a random token from top 25 by OI
  const getRandomTopToken = () => {
    const topTokens = getTopTokensByOI();
    if (topTokens.length === 0) {
      // Fallback to BTC if no data
      return { name: 'BTC', index: 0, szDecimals: 5, markPrice: 50000, maxLeverage: 50 };
    }
    const randomIndex = Math.floor(Math.random() * topTokens.length);
    return topTokens[randomIndex];
  };

  // Setup agent wallet for Hyperliquid trading
  const setupAgentWallet = async () => {
    try {
      // Generate a new random wallet for agent
      agentWallet = ethers.Wallet.createRandom();
      agentPrivateKey = agentWallet.privateKey;

      console.log('Agent wallet generated:', agentWallet.address);

      // Request user to approve the agent wallet
      const approved = await approveAgentWallet();
      if (!approved) {
        throw new Error('Agent wallet approval failed');
      }

      return true;
    } catch (error) {
      console.error('Agent wallet setup error:', error);
      return false;
    }
  };

  // Approve agent wallet via EIP-712 signature
  const approveAgentWallet = async () => {
    if (!signer || !agentWallet) {
      console.error('Signer or agent wallet not available');
      return false;
    }

    try {
      const nonce = Date.now();

      // EIP-712 typed data structure for eth_signTypedData_v4
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
          chainId: CONFIG.USER_SIGNED_CHAIN_ID,
          verifyingContract: '0x0000000000000000000000000000000000000000'
        },
        message: {
          hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
          agentAddress: agentWallet.address,
          agentName: 'PerpPlay',
          nonce: nonce
        }
      };

      console.log('Requesting agent wallet approval signature...');
      console.log('Typed data:', JSON.stringify(typedData, null, 2));

      // Request signature using eth_signTypedData_v4 directly
      const signature = await provider.send('eth_signTypedData_v4', [
        walletAddress,
        JSON.stringify(typedData)
      ]);

      console.log('Signature received:', signature);

      // Split signature into r, s, v
      const sig = ethers.utils.splitSignature(signature);

      // Send approval to Hyperliquid
      const requestBody = {
        action: {
          type: 'approveAgent',
          hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
          signatureChainId: CONFIG.USER_SIGNED_CHAIN_ID_HEX,
          agentAddress: agentWallet.address,
          agentName: 'PerpPlay',
          nonce: nonce
        },
        nonce: nonce,
        signature: {
          r: sig.r,
          s: sig.s,
          v: sig.v
        },
        vaultAddress: null
      };

      console.log('Sending to Hyperliquid:', JSON.stringify(requestBody, null, 2));

      const response = await fetch(getApiUrl() + '/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const result = await response.json();
      console.log('Agent approval response:', result);

      if (result.status === 'ok') {
        console.log('Agent wallet approved successfully');

        // Now approve builder fee
        await approveBuilderFee();

        return true;
      } else {
        console.error('Agent approval failed:', result);
        // Continue anyway for testing
        return true;
      }
    } catch (error) {
      console.error('Error approving agent wallet:', error);
      // Continue anyway for testing
      return true;
    }
  };

  // Approve builder fee for the builder address
  const approveBuilderFee = async () => {
    if (!signer) {
      console.error('Signer not available');
      return false;
    }

    try {
      const nonce = Date.now();

      // EIP-712 typed data structure for eth_signTypedData_v4
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
          chainId: CONFIG.USER_SIGNED_CHAIN_ID,
          verifyingContract: '0x0000000000000000000000000000000000000000'
        },
        message: {
          hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
          maxFeeRate: '0.05%', // 5 basis points
          builder: CONFIG.BUILDER_ADDRESS,
          nonce: nonce
        }
      };

      console.log('Requesting builder fee approval signature...');
      console.log('Builder address:', CONFIG.BUILDER_ADDRESS);

      // Request signature using eth_signTypedData_v4 directly
      const signature = await provider.send('eth_signTypedData_v4', [
        walletAddress,
        JSON.stringify(typedData)
      ]);

      console.log('Builder fee signature received:', signature);

      const sig = ethers.utils.splitSignature(signature);

      const response = await fetch(getApiUrl() + '/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: {
            type: 'approveBuilderFee',
            hyperliquidChain: CONFIG.USE_TESTNET ? 'Testnet' : 'Mainnet',
            signatureChainId: CONFIG.USER_SIGNED_CHAIN_ID_HEX,
            maxFeeRate: '0.05%',
            builder: CONFIG.BUILDER_ADDRESS,
            nonce: nonce
          },
          nonce: nonce,
          signature: {
            r: sig.r,
            s: sig.s,
            v: sig.v
          },
          vaultAddress: null
        })
      });

      const result = await response.json();
      console.log('Builder fee approval result:', result);
      return result.status === 'ok';
    } catch (error) {
      console.error('Error approving builder fee:', error);
      return true; // Continue for demo
    }
  };

  // Generate nonce for Hyperliquid
  const generateNonce = () => {
    return Date.now();
  };

  // Sign an order action using agent wallet
  const signOrderAction = async (action, nonce) => {
    if (!agentWallet) {
      throw new Error('Agent wallet not available');
    }

    // Create a connected wallet for signing
    const agentSigner = new ethers.Wallet(agentPrivateKey);

    // L1 action uses phantom agent mechanism
    // Hash the action and create phantom agent signature
    const actionHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(JSON.stringify(action) + nonce)
    );

    // For L1 actions (orders), use Arbitrum chainId
    const domain = {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: CONFIG.L1_CHAIN_ID,
      verifyingContract: '0x0000000000000000000000000000000000000000'
    };

    const types = {
      Agent: [
        { name: 'source', type: 'string' },
        { name: 'connectionId', type: 'bytes32' }
      ]
    };

    const message = {
      source: CONFIG.USE_TESTNET ? 'b' : 'a', // 'a' for mainnet, 'b' for testnet
      connectionId: actionHash
    };

    const signature = await agentSigner._signTypedData(domain, types, message);
    return ethers.utils.splitSignature(signature);
  };

  // Open a long position
  const openLongPosition = async (token, collateralUsd = 10) => {
    if (!isConnected || !agentWallet) {
      throw new Error('Wallet not connected or agent not setup');
    }

    try {
      // Refresh asset data for latest prices
      await fetchAssetMeta();

      // Calculate position size
      const markPrice = token.markPrice;
      const maxLev = token.maxLeverage || 50;

      // Use 20x if available, otherwise use 10x, capped at token's max
      let leverage;
      if (maxLev >= 20) {
        leverage = 20;
      } else if (maxLev >= 10) {
        leverage = 10;
      } else {
        leverage = maxLev;
      }

      // Position size = collateral * leverage / price
      const sizeUsd = collateralUsd * leverage;

      // Size in base units (amount of asset to buy)
      const sizeBase = sizeUsd / markPrice;

      // Round to appropriate decimals
      const szDecimals = token.szDecimals || 4;
      const roundedSize = Math.round(sizeBase * Math.pow(10, szDecimals)) / Math.pow(10, szDecimals);

      const nonce = generateNonce();

      // Order structure for Hyperliquid
      const order = {
        a: token.index, // asset index
        b: true, // is_buy = true for long
        p: markPrice.toString(), // limit price (use mark for market-ish)
        s: roundedSize.toString(), // size
        r: false, // reduce_only
        t: {
          limit: {
            tif: 'Ioc' // Immediate or Cancel for market-like execution
          }
        },
        c: null // cloid (client order id)
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

      // Sign the action
      const signature = await signOrderAction(action, nonce);

      // Submit to Hyperliquid
      const response = await fetch(getApiUrl() + '/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action,
          nonce: nonce,
          signature: signature,
          vaultAddress: null
        })
      });

      const result = await response.json();
      console.log('Open position result:', result);

      return {
        success: result.status === 'ok' || result.response?.type === 'order',
        token: token.name,
        side: 'LONG',
        size: roundedSize,
        leverage: leverage,
        collateral: collateralUsd,
        entryPrice: markPrice,
        result: result
      };
    } catch (error) {
      console.error('Error opening position:', error);
      return {
        success: false,
        error: error.message
      };
    }
  };

  // Close a position
  const closePosition = async (token, size) => {
    if (!isConnected || !agentWallet) {
      throw new Error('Wallet not connected');
    }

    try {
      // Refresh prices
      await fetchAssetMeta();

      const context = assetContexts[token.index];
      const markPrice = parseFloat(context.markPx);

      const nonce = generateNonce();

      // Close order (opposite direction, reduce only)
      const order = {
        a: token.index,
        b: false, // is_buy = false (sell to close long)
        p: markPrice.toString(),
        s: Math.abs(size).toString(),
        r: true, // reduce_only = true
        t: {
          limit: {
            tif: 'Ioc'
          }
        },
        c: null
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

      const signature = await signOrderAction(action, nonce);

      const response = await fetch(getApiUrl() + '/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: action,
          nonce: nonce,
          signature: signature,
          vaultAddress: null
        })
      });

      const result = await response.json();
      console.log('Close position result:', result);

      return {
        success: result.status === 'ok' || result.response?.type === 'order',
        closePrice: markPrice,
        result: result
      };
    } catch (error) {
      console.error('Error closing position:', error);
      return {
        success: false,
        error: error.message
      };
    }
  };

  // Execute a PerpPlay trade (open long, close after 15s)
  const executePerpPlayTrade = async (onUpdate, collateralUsd = 10) => {
    if (!isConnected) {
      return { success: false, error: 'Wallet not connected' };
    }

    try {
      // Get random token from top 25
      const token = getRandomTopToken();

      // Determine actual leverage (20x if available, else 10x)
      const maxLev = token.maxLeverage || 50;
      const actualLeverage = maxLev >= 20 ? 20 : (maxLev >= 10 ? 10 : maxLev);

      if (onUpdate) {
        onUpdate({
          phase: 'opening',
          token: token.name,
          side: 'LONG',
          leverage: actualLeverage,
          collateral: collateralUsd
        });
      }

      // Open position
      const openResult = await openLongPosition(token, collateralUsd);

      if (!openResult.success) {
        if (onUpdate) {
          onUpdate({
            phase: 'error',
            error: openResult.error || 'Failed to open position'
          });
        }
        return openResult;
      }

      const entryPrice = openResult.entryPrice;
      const size = openResult.size;

      if (onUpdate) {
        onUpdate({
          phase: 'open',
          token: token.name,
          side: 'LONG',
          leverage: openResult.leverage,
          collateral: collateralUsd,
          size: size,
          entryPrice: entryPrice
        });
      }

      // Wait 15 seconds then close
      await new Promise((resolve) => {
        let countdown = 15;
        const interval = setInterval(() => {
          countdown--;
          if (onUpdate) {
            onUpdate({
              phase: 'countdown',
              secondsRemaining: countdown,
              token: token.name,
              entryPrice: entryPrice
            });
          }
          if (countdown <= 0) {
            clearInterval(interval);
            resolve();
          }
        }, 1000);
      });

      if (onUpdate) {
        onUpdate({
          phase: 'closing',
          token: token.name
        });
      }

      // Close position
      const closeResult = await closePosition(token, size);

      // Calculate PnL
      const closePrice = closeResult.closePrice || entryPrice;
      const priceDiff = closePrice - entryPrice;
      const leverage = openResult.leverage;
      const pnlPercent = (priceDiff / entryPrice) * 100 * leverage;
      const pnlUsd = (priceDiff * size * leverage);

      const finalResult = {
        success: closeResult.success,
        token: token.name,
        side: 'LONG',
        leverage: leverage,
        collateral: collateralUsd,
        size: size,
        entryPrice: entryPrice,
        closePrice: closePrice,
        pnlPercent: pnlPercent,
        pnlUsd: pnlUsd
      };

      if (onUpdate) {
        onUpdate({
          phase: 'closed',
          ...finalResult
        });
      }

      return finalResult;
    } catch (error) {
      console.error('PerpPlay trade error:', error);
      if (onUpdate) {
        onUpdate({
          phase: 'error',
          error: error.message
        });
      }
      return { success: false, error: error.message };
    }
  };

  // Get connection status
  const getConnectionStatus = () => ({
    isConnected,
    walletAddress,
    hasAgentWallet: !!agentWallet
  });

  // Public API
  return {
    isWalletAvailable,
    connectWallet,
    disconnectWallet,
    getConnectionStatus,
    getTopTokensByOI,
    getRandomTopToken,
    executePerpPlayTrade,
    approveBuilderFee,
    CONFIG
  };
})();

// Export for use in other scripts
window.HyperliquidManager = HyperliquidManager;
