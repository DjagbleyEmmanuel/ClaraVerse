/**
 * Clara Assistant API Service
 * 
 * This service handles all API communications for the Clara Assistant,
 * using the existing AssistantAPIClient that talks directly to AI providers
 * with OpenAI-like APIs.
 */

import { AssistantAPIClient } from '../utils/AssistantAPIClient';
import type { ChatMessage } from '../utils/APIClient';
import { 
  ClaraMessage, 
  ClaraFileAttachment, 
  ClaraProvider, 
  ClaraModel, 
  ClaraAIConfig,
  ClaraArtifact,
  ClaraFileProcessingResult,
  ClaraProviderType,
  ClaraMCPToolCall,
  ClaraMCPToolResult
} from '../types/clara_assistant_types';
import { defaultTools, executeTool } from '../utils/claraTools';
import { db } from '../db';
import type { Tool } from '../db';
import { claraMCPService } from './claraMCPService';
import { addCompletionNotification, addErrorNotification, addInfoNotification } from './notificationService';
import { TokenLimitRecoveryService } from './tokenLimitRecoveryService';
import { ToolSuccessRegistry } from './toolSuccessRegistry';

/**
 * Chat request payload for Clara backend
 */
interface ClaraChatRequest {
  query: string;
  collection_name?: string;
  system_template?: string;
  k?: number;
  filter?: Record<string, any>;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  enable_tools?: boolean;
  enable_rag?: boolean;
}

/**
 * Chat response from Clara backend
 */
interface ClaraChatResponse {
  response: string;
  model?: string;
  tokens?: number;
  processing_time?: number;
  tool_calls?: any[];
  artifacts?: any[];
  error?: string;
}

/**
 * File upload response from Clara backend
 */
interface ClaraFileUploadResponse {
  document_id: number;
  filename: string;
  file_type: string;
  collection_name: string;
  processed: boolean;
  processing_result?: any;
  error?: string;
}

/**
 * Enhanced autonomous agent configuration
 */
interface AutonomousAgentConfig {
  maxRetries: number;
  retryDelay: number;
  enableSelfCorrection: boolean;
  enableToolGuidance: boolean;
  enableProgressTracking: boolean;
  maxToolCalls: number;
  confidenceThreshold: number;
}

/**
 * Tool execution attempt tracking
 */
interface ToolExecutionAttempt {
  attempt: number;
  toolName: string;
  arguments: any;
  error?: string;
  success: boolean;
  timestamp: Date;
}

/**
 * Agent execution context
 */
interface AgentExecutionContext {
  originalQuery: string;
  attempts: ToolExecutionAttempt[];
  toolsAvailable: string[];
  currentStep: number;
  maxSteps: number;
  progressLog: string[];
  toolsSummary?: string; // Add tools summary to context
  executionPlan?: string; // Add execution plan to context
}

/**
 * Tools summary and plan generation result
 */
interface ToolsPlanResult {
  summary: string;
  plan: string;
  relevantTools: string[];
  estimatedSteps: number;
}

// Add completion verification interfaces at the top of the file after other interfaces
interface CompletionAnalysis {
  originalRequest: string;
  completedComponents: ComponentStatus[];
  missingComponents: MissingItem[];
  completionStatus: 'complete' | 'partial' | 'incomplete';
  confidenceScore: number; // 0-100
  nextActions: ActionItem[];
  evidenceSummary: EvidenceMap;
}

interface ComponentStatus {
  description: string;
  status: 'completed' | 'verified' | 'attempted';
  evidence: string[];
  confidence: number;
}

interface MissingItem {
  description: string;
  priority: 'high' | 'medium' | 'low';
  requiredTools: string[];
  estimatedEffort: number;
  blockedBy: string[];
}

interface ActionItem {
  action: string;
  toolsNeeded: string[];
  expectedOutput: string;
  dependencies: string[];
}

interface EvidenceMap {
  filesCreated: string[];
  dataRetrieved: string[];
  operationsPerformed: string[];
  verificationResults: string[];
}

// Add execution step storage interfaces after other interfaces
interface ExecutionStep {
  stepNumber: number;
  timestamp: Date;
  assistantMessage: ChatMessage;
  toolCalls?: any[];
  toolResults?: any[];
  progressSummary: string;
  verificationLoop?: number;
}

interface ExecutionHistory {
  executionId: string;
  originalQuery: string;
  steps: ExecutionStep[];
  startTime: Date;
  endTime?: Date;
  finalStatus?: string;
  finalConfidence?: number;
}

export class ClaraApiService {
  private client: AssistantAPIClient | null = null;
  private currentProvider: ClaraProvider | null = null;
  private recoveryService: TokenLimitRecoveryService;
  
  // Enhanced autonomous agent configuration
  private agentConfig: AutonomousAgentConfig = {
    maxRetries: 3,
    retryDelay: 1000,
    enableSelfCorrection: true,
    enableToolGuidance: true,
    enableProgressTracking: true,
    maxToolCalls: 10,
    confidenceThreshold: 0.7
  };

  // New property for warm connections
  private warmConnections: Map<string, AbortController> = new Map();

  // Add execution storage properties
  private currentExecutionId: string | null = null;
  private executionSteps: ExecutionStep[] = [];
  
  // Add stop signal for autonomous execution
  private shouldStopExecution: boolean = false;

  constructor() {
    // Initialize the recovery service
    this.recoveryService = TokenLimitRecoveryService.getInstance();
    this.initializeFromConfig();
  }

  /**
   * Initialize execution tracking for autonomous agent
   */
  private initializeExecutionTracking(originalQuery: string): string {
    this.currentExecutionId = `execution_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.executionSteps = [];
    
    const executionHistory: ExecutionHistory = {
      executionId: this.currentExecutionId,
      originalQuery,
      steps: [],
      startTime: new Date()
    };
    
    // Store in localStorage
    try {
      localStorage.setItem(`clara_execution_${this.currentExecutionId}`, JSON.stringify(executionHistory));
      console.log(`🔍 📝 EXECUTION TRACKING: Initialized ${this.currentExecutionId}`);
    } catch (error) {
      console.warn('Failed to store execution history:', error);
    }
    
    return this.currentExecutionId;
  }

  /**
   * Record execution step with full context
   */
  private recordExecutionStep(
    stepNumber: number,
    assistantMessage: ChatMessage,
    toolCalls?: any[],
    toolResults?: any[],
    verificationLoop?: number
  ): void {
    if (!this.currentExecutionId) return;

    const progressSummary = this.extractProgressSummary(assistantMessage.content || '');
    
    // Only store essential information - exclude tool results to save space
    // Assistant messages already contain processed information from tool results
    const step: ExecutionStep = {
      stepNumber,
      timestamp: new Date(),
      assistantMessage: {
        role: assistantMessage.role,
        content: assistantMessage.content,
        tool_calls: assistantMessage.tool_calls
      },
      toolCalls, // Keep tool calls for debugging but they're small
      // toolResults excluded - they can be huge and aren't needed for verification
      progressSummary,
      verificationLoop
    };

    this.executionSteps.push(step);

    // Update localStorage
    try {
      const stored = localStorage.getItem(`clara_execution_${this.currentExecutionId}`);
      if (stored) {
        const executionHistory: ExecutionHistory = JSON.parse(stored);
        executionHistory.steps = this.executionSteps;
        localStorage.setItem(`clara_execution_${this.currentExecutionId}`, JSON.stringify(executionHistory));
        
        console.log(`🔍 📝 EXECUTION STEP ${stepNumber}: Recorded (${progressSummary.substring(0, 50)}...) - Tool results excluded to save space`);
      }
    } catch (error) {
      console.warn('Failed to update execution step:', error);
    }
  }

  /**
   * Extract progress summary from assistant message
   */
  private extractProgressSummary(content: string): string {
    // Look for progress indicators in content
    const progressLines = content.split('\n').filter(line => 
      line.includes('✅') || 
      line.includes('🔄') || 
      line.includes('**Progress') ||
      line.includes('**Current State') ||
      line.includes('**Next Steps')
    );
    
    if (progressLines.length > 0) {
      return progressLines.join(' | ').substring(0, 200);
    }
    
    // Fallback to first sentence
    const firstSentence = content.split('.')[0];
    return firstSentence.substring(0, 100);
  }

  /**
   * Finalize execution tracking
   */
  private finalizeExecutionTracking(finalStatus: string, finalConfidence: number): void {
    if (!this.currentExecutionId) return;

    try {
      const stored = localStorage.getItem(`clara_execution_${this.currentExecutionId}`);
      if (stored) {
        const executionHistory: ExecutionHistory = JSON.parse(stored);
        executionHistory.endTime = new Date();
        executionHistory.finalStatus = finalStatus;
        executionHistory.finalConfidence = finalConfidence;
        executionHistory.steps = this.executionSteps;
        
        localStorage.setItem(`clara_execution_${this.currentExecutionId}`, JSON.stringify(executionHistory));
        console.log(`🔍 📝 EXECUTION COMPLETE: ${this.currentExecutionId} - ${finalStatus} (${finalConfidence}%)`);
      }
    } catch (error) {
      console.warn('Failed to finalize execution tracking:', error);
    }
    
    // Reset tracking
    this.currentExecutionId = null;
    this.executionSteps = [];
  }

  /**
   * Get all execution steps for verification
   */
  private getAllExecutionSteps(): ExecutionStep[] {
    if (!this.currentExecutionId) return [];

    try {
      const stored = localStorage.getItem(`clara_execution_${this.currentExecutionId}`);
      if (stored) {
        const executionHistory: ExecutionHistory = JSON.parse(stored);
        
        // Convert timestamp strings back to Date objects
        if (executionHistory.steps) {
          executionHistory.steps = executionHistory.steps.map(step => ({
            ...step,
            timestamp: new Date(step.timestamp)
          }));
        }
        
        return executionHistory.steps || [];
      }
    } catch (error) {
      console.warn('Failed to retrieve execution steps:', error);
    }
    
    return this.executionSteps;
  }

  /**
   * Initialize API service from database configuration
   */
  private async initializeFromConfig() {
    try {
      const primaryProvider = await this.getPrimaryProvider();
      if (primaryProvider) {
        this.updateProvider(primaryProvider);
      }
    } catch (error) {
      console.warn('Failed to load primary provider:', error);
    }
  }

  /**
   * Update API client for a specific provider
   */
  public updateProvider(provider: ClaraProvider) {
    this.currentProvider = provider;
    this.client = new AssistantAPIClient(provider.baseUrl || '', {
      apiKey: provider.apiKey || '',
      providerId: provider.id // Pass provider ID for tool error tracking
    });
  }

  /**
   * Get available providers from database
   */
  public async getProviders(): Promise<ClaraProvider[]> {
    try {
      const dbProviders = await db.getAllProviders();
      
      // Convert DB providers to Clara providers
      const claraProviders: ClaraProvider[] = dbProviders.map(provider => ({
        id: provider.id,
        name: provider.name,
        type: provider.type as ClaraProviderType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        isEnabled: provider.isEnabled,
        isPrimary: provider.isPrimary,
        config: provider.config
      }));

      return claraProviders;
    } catch (error) {
      console.error('Failed to get providers:', error);
      return [];
    }
  }

  /**
   * Get available models from all providers or a specific provider
   */
  public async getModels(providerId?: string): Promise<ClaraModel[]> {
    const models: ClaraModel[] = [];
    const providers = await this.getProviders();
    
    // Filter providers based on providerId parameter
    const targetProviders = providerId 
      ? providers.filter(p => p.id === providerId && p.isEnabled)
      : providers.filter(p => p.isEnabled);

    for (const provider of targetProviders) {
      try {
        // Create temporary client for this provider
        const tempClient = new AssistantAPIClient(provider.baseUrl || '', {
          apiKey: provider.apiKey || '',
          providerId: provider.id // Pass provider ID for tool error tracking
        });
        
        const providerModels = await tempClient.listModels();
        
        for (const model of providerModels) {
          const claraModel: ClaraModel = {
            id: `${provider.id}:${model.id}`,
            name: model.name || model.id,
            provider: provider.id,
            type: this.detectModelType(model.name || model.id),
            size: model.size,
            supportsVision: this.supportsVision(model.name || model.id),
            supportsCode: this.supportsCode(model.name || model.id),
            supportsTools: this.supportsTools(model.name || model.id),
            metadata: {
              digest: model.digest,
              modified_at: model.modified_at
            }
          };
          
          models.push(claraModel);
        }
      } catch (error) {
        console.warn(`Failed to get models from provider ${provider.name}:`, error);
      }
    }

    return models;
  }

  /**
   * Get models from the currently selected provider only
   */
  public async getCurrentProviderModels(): Promise<ClaraModel[]> {
    if (!this.currentProvider) {
      return [];
    }
    
    return this.getModels(this.currentProvider.id);
  }

  /**
   * Send a chat message using the AssistantAPIClient with enhanced autonomous agent capabilities
   */
  public async sendChatMessage(
    message: string,
    config: ClaraAIConfig,
    attachments?: ClaraFileAttachment[],
    systemPrompt?: string,
    conversationHistory?: ClaraMessage[],
    onContentChunk?: (content: string) => void
  ): Promise<ClaraMessage> {
    if (!this.client) {
      throw new Error('No API client configured. Please select a provider.');
    }

    // CRITICAL FIX: Switch to the provider specified in config if different from current
    if (config.provider && (!this.currentProvider || this.currentProvider.id !== config.provider)) {
      console.log(`🔄 Switching provider from ${this.currentProvider?.id || 'none'} to ${config.provider}`);
      try {
        const providers = await this.getProviders();
        const requestedProvider = providers.find(p => p.id === config.provider);
        
        if (requestedProvider) {
          console.log(`✅ Found provider ${config.provider}:`, {
            name: requestedProvider.name,
            baseUrl: requestedProvider.baseUrl,
            isEnabled: requestedProvider.isEnabled
          });
          
          if (!requestedProvider.isEnabled) {
            throw new Error(`Provider ${requestedProvider.name} is not enabled`);
          }
          
          // Update the client to use the requested provider
          this.updateProvider(requestedProvider);
          console.log(`🚀 Switched to provider: ${requestedProvider.name} (${requestedProvider.baseUrl})`);
        } else {
          throw new Error(`Provider ${config.provider} not found or not configured`);
        }
      } catch (error) {
        console.error(`❌ Failed to switch to provider ${config.provider}:`, error);
        throw new Error(`Failed to switch to provider ${config.provider}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    } else if (config.provider) {
      console.log(`✅ Already using correct provider: ${this.currentProvider?.name} (${this.currentProvider?.baseUrl})`);
    }

    try {
      // Update agent config from session config
      console.log(`🔧 Original agent config:`, this.agentConfig);
      if (config.autonomousAgent) {
        console.log(`🔄 Updating agent config from session config:`, config.autonomousAgent);
        this.agentConfig = {
          maxRetries: config.autonomousAgent.maxRetries,
          retryDelay: config.autonomousAgent.retryDelay,
          enableSelfCorrection: config.autonomousAgent.enableSelfCorrection,
          enableToolGuidance: config.autonomousAgent.enableToolGuidance,
          enableProgressTracking: config.autonomousAgent.enableProgressTracking,
          maxToolCalls: config.autonomousAgent.maxToolCalls,
          confidenceThreshold: config.autonomousAgent.confidenceThreshold
        };
        console.log(`✅ Updated agent config:`, this.agentConfig);
      } else {
        console.log(`⚠️ No autonomousAgent config provided, using defaults`);
      }

      // Initialize agent execution context
      const agentContext: AgentExecutionContext = {
        originalQuery: message,
        attempts: [],
        toolsAvailable: [],
        currentStep: 0,
        maxSteps: this.agentConfig.maxToolCalls,
        progressLog: []
      };

      console.log(`🎯 Agent context initialized with maxSteps: ${agentContext.maxSteps}`);
      console.log(`🔧 Agent config maxToolCalls: ${this.agentConfig.maxToolCalls}`);

      // Process file attachments if any
      const processedAttachments = await this.processFileAttachments(attachments || []);

      // Determine the appropriate model based on context and auto selection settings
      let modelId = this.selectAppropriateModel(config, message, processedAttachments, conversationHistory);
      
      // If the model ID includes the provider prefix (e.g., "ollama:qwen3:30b"), 
      // extract everything after the first colon to get the actual model name
      if (modelId.includes(':')) {
        const parts = modelId.split(':');
        // Remove the provider part (first element) and rejoin the rest
        const originalModelId = modelId;
        modelId = parts.slice(1).join(':');
        console.log(`Model ID extraction: "${originalModelId}" -> "${modelId}"`);
      }
      
      console.log(`🤖 Starting autonomous agent with model: "${modelId}"`);
      console.log('🔧 Agent configuration:', this.agentConfig);

      // Get tools if enabled
      let tools: Tool[] = [];
      if (config.features.enableTools) {
        const dbTools = await db.getEnabledTools();
        tools = dbTools;
        
        // Add MCP tools if enabled
        if (config.features.enableMCP && config.mcp?.enableTools) {
          console.log('🔧 MCP is enabled, attempting to add MCP tools...');
          try {
            // Ensure MCP service is ready
            if (claraMCPService.isReady()) {
              console.log('✅ MCP service is ready');
              
              // Get enabled servers from config
              const enabledServers = config.mcp.enabledServers || [];
              console.log('📋 Enabled MCP servers from config:', enabledServers);
              
              // CRITICAL FIX: Only proceed if servers are explicitly enabled
              // Don't fall back to all servers when none are selected
              if (enabledServers.length === 0) {
                console.log('🚫 No MCP servers explicitly enabled - skipping MCP tools');
                if (onContentChunk) {
                  onContentChunk('ℹ️ **No MCP servers selected** - Please enable specific MCP servers in configuration to use MCP tools.\n\n');
                }
              } else {
                // Check server availability and provide feedback
                const serverSummary = claraMCPService.getServerAvailabilitySummary(enabledServers);
                console.log('🔍 Server availability summary:', serverSummary);
                
                // Provide UI feedback about server status
                if (onContentChunk && serverSummary.unavailable.length > 0) {
                  let feedbackMessage = '\n🔧 **MCP Server Status:**\n';
                  
                  if (serverSummary.available.length > 0) {
                    feedbackMessage += `✅ Available: ${serverSummary.available.join(', ')} (${serverSummary.totalTools} tools)\n`;
                  }
                  
                  if (serverSummary.unavailable.length > 0) {
                    feedbackMessage += '❌ Unavailable servers:\n';
                    for (const unavailable of serverSummary.unavailable) {
                      feedbackMessage += `   • ${unavailable.server}: ${unavailable.reason}\n`;
                    }
                  }
                  
                  feedbackMessage += '\n';
                  onContentChunk(feedbackMessage);
                }
                
                // Get tools only from explicitly enabled servers
                const mcpTools = claraMCPService.getToolsFromEnabledServers(enabledServers);
                console.log(`🛠️ Found ${mcpTools.length} MCP tools from enabled servers:`, mcpTools.map(t => `${t.server}:${t.name}`));
                
                if (mcpTools.length === 0) {
                  console.warn('⚠️ No MCP tools available from enabled/running servers');
                  if (onContentChunk) {
                    onContentChunk('⚠️ **No MCP tools available** - all configured servers are offline or disabled.\n\n');
                  }
                } else {
                  // Convert only the filtered tools to OpenAI format
                  const mcpOpenAITools = claraMCPService.convertSpecificToolsToOpenAIFormat(mcpTools);
                  console.log(`🔄 Converted and validated ${mcpOpenAITools.length} OpenAI format tools`);
                  
                  // Convert to Tool format for compatibility
                  const mcpToolsFormatted: Tool[] = mcpOpenAITools.map(tool => ({
                    id: tool.function.name,
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: Object.entries(tool.function.parameters.properties || {}).map(([name, prop]: [string, any]) => ({
                      name,
                      type: prop.type || 'string',
                      description: prop.description || '',
                      required: tool.function.parameters.required?.includes(name) || false
                    })),
                    implementation: 'mcp', // Mark as MCP tool for special handling
                    isEnabled: true
                  }));
                  
                  const beforeCount = tools.length;
                  tools = [...tools, ...mcpToolsFormatted];
                  console.log(`📈 Added ${mcpToolsFormatted.length} MCP tools to existing ${beforeCount} tools (total: ${tools.length})`);
                  
                  // Provide UI feedback about loaded tools
                  if (onContentChunk && mcpToolsFormatted.length > 0) {
                    const toolsByServer = mcpToolsFormatted.reduce((acc, tool) => {
                      const serverName = tool.name.split('_')[1]; // Extract server name from mcp_server_tool format
                      acc[serverName] = (acc[serverName] || 0) + 1;
                      return acc;
                    }, {} as Record<string, number>);
                    
                    let toolsMessage = `🛠️ **Loaded ${mcpToolsFormatted.length} MCP tools:**\n`;
                    for (const [server, count] of Object.entries(toolsByServer)) {
                      toolsMessage += `   • ${server}: ${count} tools\n`;
                    }
                    toolsMessage += '\n';
                    onContentChunk(toolsMessage);
                  }
                  
                  // Update agent context with available tools
                  agentContext.toolsAvailable = tools.map(t => t.name);
                }
              }
            } else {
              console.warn('⚠️ MCP service not ready, skipping MCP tools');
              if (onContentChunk) {
                onContentChunk('⚠️ **MCP service not ready** - skipping MCP tools. Please check your MCP configuration.\n\n');
              }
            }
          } catch (error) {
            console.error('❌ Error adding MCP tools:', error);
            if (onContentChunk) {
              onContentChunk(`❌ **Error loading MCP tools:** ${error instanceof Error ? error.message : 'Unknown error'}\n\n`);
            }
          }
        } else {
          console.log('🚫 MCP tools disabled:', {
            enableMCP: config.features.enableMCP,
            enableTools: config.mcp?.enableTools
          });
          if (onContentChunk && config.features.enableMCP === false) {
            onContentChunk('ℹ️ **MCP tools disabled** in configuration.\n\n');
          }
        }
      }

      // Check if autonomous agent mode is enabled
      const isAutonomousMode = config.autonomousAgent?.enabled !== false;
      
      if (isAutonomousMode) {
        console.log(`🤖 Autonomous agent mode enabled - using enhanced workflow`);
        
        // Add notification for autonomous mode start
        addInfoNotification(
          'Autonomous Mode Activated',
          'Clara is now operating in autonomous mode with enhanced capabilities.',
          3000
        );
        
        // Enhanced system prompt with autonomous agent capabilities
        const enhancedSystemPrompt = this.buildEnhancedSystemPrompt(systemPrompt, tools, agentContext);

        // Prepare initial messages array
        const messages: ChatMessage[] = [];
        
        // Add enhanced system prompt
        messages.push({
          role: 'system',
          content: enhancedSystemPrompt
        });

        // Add conversation history if provided
        if (conversationHistory && conversationHistory.length > 0) {
          // Convert Clara messages to ChatMessage format
          // The conversationHistory already includes the current user message at the end,
          // so we exclude it since we'll add it separately with the correct content (including voice prefix)
          const historyMessages = conversationHistory.slice(0, -1);
          console.log(`📚 Adding ${historyMessages.length} history messages to context (total history: ${conversationHistory.length})`);
          
          for (const historyMessage of historyMessages) {
            const chatMessage: ChatMessage = {
              role: historyMessage.role,
              content: historyMessage.content
            };

            // Add images if the message has image attachments
            if (historyMessage.attachments) {
              const imageAttachments = historyMessage.attachments.filter(att => att.type === 'image');
              if (imageAttachments.length > 0) {
                chatMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
              }
            }

            messages.push(chatMessage);
          }
        } else {
          console.log('📚 No conversation history provided');
        }

        // Add the current user message
        const userMessage: ChatMessage = {
          role: 'user',
          content: message  // Always use the message parameter, not conversation history content
        };

        // Add images if any attachments are images
        const imageAttachments = processedAttachments.filter(att => att.type === 'image');
        if (imageAttachments.length > 0) {
          userMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
        } else if (conversationHistory && conversationHistory.length > 0) {
          // Check the last message in conversation history for images
          const currentMessage = conversationHistory[conversationHistory.length - 1];
          if (currentMessage?.attachments) {
            const historyImageAttachments = currentMessage.attachments.filter(att => att.type === 'image');
            if (historyImageAttachments.length > 0) {
              userMessage.images = historyImageAttachments.map(att => att.base64 || att.url || '');
            }
          }
        }

        messages.push(userMessage);

        console.log(`🚀 Starting autonomous agent execution with ${messages.length} messages and ${tools.length} tools`);
        console.log(`📝 Final message breakdown: ${messages.filter(m => m.role === 'system').length} system, ${messages.filter(m => m.role === 'user').length} user, ${messages.filter(m => m.role === 'assistant').length} assistant`);

        // Execute autonomous agent workflow
        const result = await this.executeAutonomousAgent(
          modelId, 
          messages, 
          tools, 
          config, 
          agentContext,
          conversationHistory, // Pass conversation history to autonomous agent
          onContentChunk
        );

        // Add completion notification for autonomous mode
        const toolsUsed = result.metadata?.toolsUsed || [];
        const agentSteps = result.metadata?.agentSteps || 1;
        
        addCompletionNotification(
          'Autonomous Agent Complete',
          `Completed in ${agentSteps} steps${toolsUsed.length > 0 ? ` using ${toolsUsed.length} tools` : ''}.`,
          5000
        );

        return result;
        
      } else {
        console.log(`💬 Standard chat mode - using direct execution`);
        
        // Standard system prompt without autonomous agent features
        const standardSystemPrompt = systemPrompt || 'You are Clara, a helpful AI assistant.';

        // Prepare messages array for standard chat
        const messages: ChatMessage[] = [];
        
        // Add standard system prompt
              messages.push({
          role: 'system',
          content: standardSystemPrompt
        });

        // Add conversation history if provided
        if (conversationHistory && conversationHistory.length > 0) {
          // Convert Clara messages to ChatMessage format, excluding the last message since it's the current one
          const historyMessages = conversationHistory.slice(0, -1);
          for (const historyMessage of historyMessages) {
            const chatMessage: ChatMessage = {
              role: historyMessage.role,
              content: historyMessage.content
            };

            // Add images if the message has image attachments
            if (historyMessage.attachments) {
              const imageAttachments = historyMessage.attachments.filter(att => att.type === 'image');
              if (imageAttachments.length > 0) {
                chatMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
              }
            }

            messages.push(chatMessage);
          }
          console.log(`📚 Added ${conversationHistory.length - 1} history messages to standard chat context`);
        } else {
          console.log('📚 No conversation history provided for standard chat');
        }

        // Add the current user message
        const userMessage: ChatMessage = {
          role: 'user',
          content: message  // Always use the message parameter, not conversation history content
        };

        // Add images if any attachments are images
        const imageAttachments = processedAttachments.filter(att => att.type === 'image');
        if (imageAttachments.length > 0) {
          userMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
        } else if (conversationHistory && conversationHistory.length > 0) {
          // Check the last message in conversation history for images
          const currentMessage = conversationHistory[conversationHistory.length - 1];
          if (currentMessage?.attachments) {
            const historyImageAttachments = currentMessage.attachments.filter(att => att.type === 'image');
            if (historyImageAttachments.length > 0) {
              userMessage.images = historyImageAttachments.map(att => att.base64 || att.url || '');
            }
          }
        }

        messages.push(userMessage);

        console.log(`💬 Starting standard chat execution with ${messages.length} messages and ${tools.length} tools`);
        console.log(`📝 Final message breakdown: ${messages.filter(m => m.role === 'system').length} system, ${messages.filter(m => m.role === 'user').length} user, ${messages.filter(m => m.role === 'assistant').length} assistant`);

        // Execute standard chat workflow
        const result = await this.executeStandardChat(
          modelId, 
          messages, 
          tools, 
          config,
          onContentChunk
        );

        return result;
      }

    } catch (error) {
      console.error('Autonomous agent execution failed:', error);
      
      // Check if this is an abort error (user stopped the stream)
      const isAbortError = error instanceof Error && (
        error.message.includes('aborted') ||
        error.message.includes('BodyStreamBuffer was aborted') ||
        error.message.includes('AbortError') ||
        error.name === 'AbortError'
      );
      
      if (isAbortError) {
        console.log('Stream was aborted by user, returning partial content');
        
        return {
          id: `${Date.now()}-aborted`,
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          metadata: {
            model: `${config.provider}:${config.models.text || 'unknown'}`,
            temperature: config.parameters.temperature,
            aborted: true,
            error: 'Stream was stopped by user'
          }
        };
      }
      
      // Return error message only for actual errors (not user aborts)
      return {
        id: `${Date.now()}-error`,
        role: 'assistant',
        content: 'I apologize, but I encountered an error while processing your request. Please try again.',
        timestamp: new Date(),
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error occurred'
        }
      };
    }
  }

  /**
   * Process file attachments by analyzing them locally
   */
  private async processFileAttachments(attachments: ClaraFileAttachment[]): Promise<ClaraFileAttachment[]> {
    const processed = [...attachments];

    for (const attachment of processed) {
      try {
        // For images, we already have base64 or URL - mark as processed
        if (attachment.type === 'image') {
          attachment.processed = true;
          attachment.processingResult = {
            success: true,
            metadata: {
              type: 'image',
              processedAt: new Date().toISOString()
            }
          };
        }

        // For PDFs and documents, we could add text extraction here
        // For now, mark as processed but note that extraction isn't implemented
        if (attachment.type === 'pdf' || attachment.type === 'document') {
          attachment.processed = true;
          attachment.processingResult = {
            success: true,
            extractedText: 'Text extraction not yet implemented in client-side processing.',
            metadata: {
              type: attachment.type,
              processedAt: new Date().toISOString(),
              note: 'Full document processing requires backend integration'
            }
          };
        }

        // For code files, we can analyze the structure
        if (attachment.type === 'code') {
          attachment.processed = true;
          attachment.processingResult = {
            success: true,
            codeAnalysis: {
              language: this.detectCodeLanguage(attachment.name),
              structure: {
                functions: [],
                classes: [],
                imports: []
              },
              metrics: {
                lines: 0,
                complexity: 0
              }
            },
            metadata: {
              type: 'code',
              processedAt: new Date().toISOString()
            }
          };
        }

      } catch (error) {
        attachment.processed = false;
        attachment.processingResult = {
          success: false,
          error: error instanceof Error ? error.message : 'Processing failed'
        };
      }
    }

    return processed;
  }

  /**
   * Execute tool calls using the Clara tools system
   */
  private async executeToolCalls(toolCalls: any[]): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      try {
        const functionName = toolCall.function?.name;
        
        // Add detailed debug logging for tool call structure
        console.log(`🔍 [DEBUG] Raw tool call object:`, JSON.stringify(toolCall, null, 2));
        console.log(`🔍 [DEBUG] Function name:`, functionName);
        console.log(`🔍 [DEBUG] Raw arguments:`, toolCall.function?.arguments);
        console.log(`🔍 [DEBUG] Arguments type:`, typeof toolCall.function?.arguments);
        
        // Safely parse arguments with better error handling
        let args = {};
        try {
          if (typeof toolCall.function?.arguments === 'string') {
            const argsString = toolCall.function.arguments.trim();
            console.log(`🔍 [DEBUG] Arguments string (trimmed):`, argsString);
            if (argsString === '' || argsString === 'null' || argsString === 'undefined') {
              args = {};
              console.log(`🔍 [DEBUG] Empty arguments, using empty object`);
            } else {
              args = JSON.parse(argsString);
              console.log(`🔍 [DEBUG] Parsed arguments:`, args);
            }
          } else if (toolCall.function?.arguments && typeof toolCall.function.arguments === 'object') {
            args = toolCall.function.arguments;
            console.log(`🔍 [DEBUG] Using object arguments directly:`, args);
          } else {
            args = {};
            console.log(`🔍 [DEBUG] No valid arguments, using empty object`);
          }
        } catch (parseError) {
          console.warn(`⚠️ Failed to parse tool arguments for ${functionName}:`, parseError);
          console.warn(`⚠️ Raw arguments:`, toolCall.function?.arguments);
          args = {};
        }

        // Check for malformed tool calls
        if (!functionName || functionName.trim() === '') {
          console.warn('⚠️ Skipping malformed tool call with empty function name:', toolCall);
          const result = {
            toolName: 'unknown',
            success: false,
            error: 'Tool call has empty or missing function name'
          };
          results.push(result);
          continue;
        }

        console.log(`🔧 Executing tool: ${functionName} with args:`, args);

        // Check if this is an MCP tool call
        if (functionName?.startsWith('mcp_')) {
          console.log(`🔧 [API] Processing MCP tool call: ${functionName}`);
          try {
            // Add debug logging before parsing
            console.log(`🔍 [API] Tool call before parsing:`, JSON.stringify(toolCall, null, 2));
            console.log(`🔍 [API] Parsed args before MCP:`, args);
            
            // Parse MCP tool calls and execute them
            console.log(`🔍 [API] Parsing tool call:`, toolCall);
            const mcpToolCalls = claraMCPService.parseOpenAIToolCalls([toolCall]);
            console.log(`📋 [API] Parsed MCP tool calls:`, mcpToolCalls);
            
            if (mcpToolCalls.length > 0) {
              console.log(`📡 [API] Executing MCP tool call:`, mcpToolCalls[0]);
              console.log(`🔍 [API] MCP tool call arguments:`, mcpToolCalls[0].arguments);
              const mcpResult = await claraMCPService.executeToolCall(mcpToolCalls[0]);
              console.log(`📥 [API] MCP execution result:`, mcpResult);
              
              // Process the MCP result comprehensively
              const processedResult = this.processMCPToolResult(mcpResult, functionName);
              
              const result = {
                toolName: functionName,
                success: mcpResult.success,
                result: processedResult.result,
                error: mcpResult.error,
                artifacts: processedResult.artifacts,
                images: processedResult.images,
                toolMessage: processedResult.toolMessage,
                metadata: {
                  type: 'mcp',
                  server: mcpToolCalls[0].server,
                  toolName: mcpToolCalls[0].name,
                  ...mcpResult.metadata
                }
              };

              console.log(`✅ MCP tool ${functionName} result:`, result);
              
              // Record successful MCP tool execution to prevent false positive blacklisting
              if (result.success) {
                ToolSuccessRegistry.recordSuccess(
                  functionName,
                  'MCP tool',
                  this.currentProvider?.id || 'unknown',
                  toolCall.id
                );
              }
              
              results.push(result);
            } else {
              console.error(`❌ [API] Failed to parse MCP tool call`);
              const result = {
                toolName: functionName,
                success: false,
                error: 'Failed to parse MCP tool call'
              };
              console.log(`❌ MCP tool ${functionName} failed:`, result);
              results.push(result);
            }
          } catch (mcpError) {
            console.error(`❌ [API] MCP tool execution error:`, mcpError);
            const result = {
              toolName: functionName,
              success: false,
              error: mcpError instanceof Error ? mcpError.message : 'MCP tool execution failed'
            };
            console.log(`❌ MCP tool ${functionName} error:`, result);
            results.push(result);
          }
          continue;
        }

        // Try to execute with Clara tools first
        const claraTool = defaultTools.find(tool => tool.name === functionName || tool.id === functionName);
        
        if (claraTool) {
          const result = await executeTool(claraTool.id, args);
          console.log(`✅ Clara tool ${functionName} result:`, result);
          
          // Record successful tool execution to prevent false positive blacklisting
          if (result.success) {
            ToolSuccessRegistry.recordSuccess(
              claraTool.name,
              claraTool.description,
              this.currentProvider?.id || 'unknown',
              toolCall.id
            );
          }
          
          results.push({
            toolName: functionName,
            success: result.success,
            result: result.result,
            error: result.error
          });
        } else {
          // Try database tools as fallback
          const dbTools = await db.getEnabledTools();
          const dbTool = dbTools.find(tool => tool.name === functionName);
          
          if (dbTool) {
            // Execute database tool (simplified implementation)
            try {
              const funcBody = `return (async () => {
                ${dbTool.implementation}
                return await implementation(args);
              })();`;
              const testFunc = new Function('args', funcBody);
              const result = await testFunc(args);
              
              console.log(`✅ Database tool ${functionName} result:`, result);
              
              // Record successful tool execution to prevent false positive blacklisting
              ToolSuccessRegistry.recordSuccess(
                dbTool.name,
                dbTool.description,
                this.currentProvider?.id || 'unknown',
                toolCall.id
              );
              
              results.push({
                toolName: functionName,
                success: true,
                result: result
              });
            } catch (error) {
              const result = {
                toolName: functionName,
                success: false,
                error: error instanceof Error ? error.message : 'Tool execution failed'
              };
              console.log(`❌ Database tool ${functionName} error:`, result);
              results.push(result);
            }
          } else {
            const result = {
              toolName: functionName,
              success: false,
              error: `Tool '${functionName}' not found`
            };
            console.log(`❌ Tool ${functionName} not found:`, result);
            results.push(result);
          }
        }
      } catch (error) {
        const result = {
          toolName: toolCall.function?.name || 'unknown',
          success: false,
          error: error instanceof Error ? error.message : 'Tool execution failed'
        };
        console.log(`❌ Tool execution error for ${toolCall.function?.name || 'unknown'}:`, result);
        results.push(result);
      }
    }

    console.log(`🔧 Tool execution summary: ${results.length} tools executed, ${results.filter(r => r.success).length} successful, ${results.filter(r => !r.success).length} failed`);
    return results;
  }

  /**
   * Parse tool results into artifacts if appropriate
   */
  private parseToolResultsToArtifacts(toolResults: any[]): ClaraArtifact[] {
    const artifacts: ClaraArtifact[] = [];

    for (const result of toolResults) {
      if (result.success) {
        // Add MCP artifacts if available
        if (result.artifacts && Array.isArray(result.artifacts)) {
          artifacts.push(...result.artifacts);
        }
        
        // Create artifacts for other tool results
        if (result.result && typeof result.result === 'object' && !result.artifacts) {
          artifacts.push({
            id: `tool-result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'json',
            title: `${result.toolName} Result`,
            content: JSON.stringify(result.result, null, 2),
            createdAt: new Date(),
            metadata: {
              toolName: result.toolName,
              toolExecuted: true
            }
          });
        }
      }
    }

    return artifacts;
  }

  /**
   * Detect code language from filename
   */
  private detectCodeLanguage(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'swift': 'swift',
      'kt': 'kotlin'
    };
    return langMap[ext || ''] || 'text';
  }

  /**
   * Detect model type based on model name
   */
  private detectModelType(modelName: string): 'text' | 'vision' | 'code' | 'embedding' | 'multimodal' {
    const name = modelName.toLowerCase();
    
    if (name.includes('vision') || name.includes('llava') || name.includes('gpt-4-vision')) {
      return 'vision';
    }
    
    if (name.includes('code') || name.includes('coder') || name.includes('codellama')) {
      return 'code';
    }
    
    if (name.includes('embed') || name.includes('embedding')) {
      return 'embedding';
    }
    
    if (name.includes('gpt-4') || name.includes('claude') || name.includes('multimodal')) {
      return 'multimodal';
    }
    
    return 'text';
  }

  /**
   * Check if model supports vision
   */
  private supportsVision(modelName: string): boolean {
    // Remove filter - allow all models to be used for vision tasks
    return true;
  }

  /**
   * Check if model supports code generation
   */
  private supportsCode(modelName: string): boolean {
    // Remove filter - allow all models to be used for code tasks  
    return true;
  }

  /**
   * Check if model supports tool calling
   */
  private supportsTools(modelName: string): boolean {
    const name = modelName.toLowerCase();
    return name.includes('gpt-4') || 
           name.includes('gpt-3.5-turbo') ||
           name.includes('claude-3') ||
           name.includes('gemini');
  }

  /**

  /**
   * Get primary provider
   */
  public async getPrimaryProvider(): Promise<ClaraProvider | null> {
    try {
      const dbProvider = await db.getPrimaryProvider();
      if (!dbProvider) return null;

      return {
        id: dbProvider.id,
        name: dbProvider.name,
        type: dbProvider.type as ClaraProviderType,
        baseUrl: dbProvider.baseUrl,
        apiKey: dbProvider.apiKey,
        isEnabled: dbProvider.isEnabled,
        isPrimary: dbProvider.isPrimary,
        config: dbProvider.config
      };
    } catch (error) {
      console.error('Failed to get primary provider:', error);
      return null;
    }
  }

  /**
   * Set primary provider
   */
  public async setPrimaryProvider(providerId: string): Promise<void> {
    try {
      await db.setPrimaryProvider(providerId);
      
      // Update current client to use new primary provider
      const newPrimary = await this.getPrimaryProvider();
      if (newPrimary) {
        this.updateProvider(newPrimary);
      }
    } catch (error) {
      console.error('Failed to set primary provider:', error);
      throw error;
    }
  }

  /**
   * Health check for current provider
   */
  public async healthCheck(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    try {
      return await this.client.checkConnection();
    } catch (error) {
      console.warn('Provider health check failed:', error);
      return false;
    }
  }

  /**
   * Test connection to a provider
   */
  public async testProvider(provider: ClaraProvider): Promise<boolean> {
    try {
      const testClient = new AssistantAPIClient(provider.baseUrl || '', {
        apiKey: provider.apiKey || '',
        providerId: provider.id // Pass provider ID for tool error tracking
      });
      
      return await testClient.checkConnection();
    } catch (error) {
      console.warn(`Provider ${provider.name} connection test failed:`, error);
      return false;
    }
  }

  /**
   * Stop the current chat generation and autonomous execution
   */
  public stop(): void {
    // Set the stop flag to halt autonomous execution
    this.shouldStopExecution = true;
    console.log('🛑 Stop signal sent - autonomous execution will halt');
    
    if (this.client) {
      // The client extends APIClient which has the abortStream method
      const apiClient = this.client as any;
      if (typeof apiClient.abortStream === 'function') {
        apiClient.abortStream();
        console.log('Stream aborted successfully');
      } else {
        console.warn('AbortStream method not available on client');
      }
    } else {
      console.warn('No client available to abort');
    }
  }

  /**
   * Get current API client instance
   */
  public getCurrentClient(): AssistantAPIClient | null {
    return this.client;
  }

  /**
   * Get current provider
   */
  public getCurrentProvider(): ClaraProvider | null {
    return this.currentProvider;
  }

  /**
   * Build enhanced system prompt with autonomous agent capabilities
   */
  private buildEnhancedSystemPrompt(
    originalPrompt: string | undefined, 
    tools: Tool[], 
    context: AgentExecutionContext
  ): string {
    const toolsList = tools.map(tool => {
      const requiredParams = tool.parameters.filter(p => p.required).map(p => p.name);
      const optionalParams = tool.parameters.filter(p => !p.required).map(p => p.name);
      
      return `- ${tool.name}: ${tool.description}
  Required: ${requiredParams.join(', ') || 'none'}
  Optional: ${optionalParams.join(', ') || 'none'}`;
    }).join('\n');

    // Include tools summary and execution plan if available
    const toolsSummarySection = context.toolsSummary ? `
🎯 TOOLS SUMMARY:
${context.toolsSummary}

📋 EXECUTION PLAN:
${context.executionPlan || 'Plan will be determined based on your request.'}
` : '';

    const enhancedPrompt = `${originalPrompt || 'You are Clara, a helpful AI assistant.'}

🚀 AUTONOMOUS AGENT MODE ACTIVATED 🚀

You are now operating as an advanced autonomous agent with the following capabilities:

${toolsSummarySection}

CORE PRINCIPLES:
1. **Follow the Plan**: Use the execution plan above as your guide, but adapt as needed based on results.
2. **Context Awareness**: Remember what each tool call accomplished and build upon previous results.
3. **Sequential Logic**: For terminal/command tools, run the command THEN check the output in the next step.
4. **No Repetition**: Avoid calling the same tool with the same parameters repeatedly.
5. **Result Chaining**: Use the output from one tool as input for the next when logical.

TOOL EXECUTION STRATEGY:
- **Step 1**: Execute the first tool in your plan
- **Step 2**: Analyze the result and determine the next logical action
- **Step 3**: If the result suggests a follow-up action (like checking command output), do it immediately
- **Step 4**: Continue until the user's request is fully satisfied

FALLBACK STRATEGY:
- On first failure: parse the error, fix parameters, and retry.
- If failures exceed ${this.agentConfig.maxRetries}: choose an alternative tool or approach.
- If no suitable tool remains: provide the best answer possible with available information.

AVAILABLE TOOLS:
${toolsList || 'No tools available'}

RESPONSE FORMAT:
1. **Current Step**: Briefly state what you're doing now
2. **Tool Usage**: Execute tools with clear purpose
3. **Result Analysis**: Explain what the tool result means and what to do next
4. **Final Answer**: Provide a clear, concise response to the user

Remember: You are autonomous and intelligent. Chain tool results logically, avoid redundant calls, and always work toward completing the user's request efficiently.`;

    return enhancedPrompt;
  }

  /**
   * Execute autonomous agent workflow with retry mechanisms and self-correction
   */
  private async executeAutonomousAgent(
    modelId: string,
    messages: ChatMessage[],
    tools: Tool[],
    config: ClaraAIConfig,
    context: AgentExecutionContext,
    conversationHistory?: ClaraMessage[],
    onContentChunk?: (content: string) => void
  ): Promise<ClaraMessage> {
    const options = {
      temperature: config.parameters.temperature,
      max_tokens: config.parameters.maxTokens,
      top_p: config.parameters.topP
    };

    let responseContent = '';
    let totalTokens = 0;
    let allToolResults: any[] = [];
    let finalUsage: any = {};
    let finalTimings: any = {};
    let conversationMessages = [...messages];
    
    // Track processed tool call IDs to prevent duplicates
    const processedToolCallIds = new Set<string>();

    // Initialize execution tracking
    const executionId = this.initializeExecutionTracking(context.originalQuery);
    
    // Reset stop signal for new execution
    this.shouldStopExecution = false;
    
    // Progress tracking - use professional status instead of emoji messages
    if (onContentChunk && this.agentConfig.enableProgressTracking) {
      onContentChunk('**AGENT_STATUS:ACTIVATED**\n');
    }

    console.log(`🔍 Starting autonomous agent loop with maxSteps: ${context.maxSteps}`);
    
    // STEP 1: Generate tools summary and execution plan if tools are available
    if (tools.length > 0) {
      try {
        console.log(`🧠 Generating tools summary and plan for ${tools.length} tools`);
        const planResult = await this.generateToolsSummaryAndPlan(
          context.originalQuery,
          tools,
          modelId,
          conversationHistory, // Use the conversation history parameter passed to this method
          onContentChunk
        );
        
        // Update context with planning results
        context.toolsSummary = planResult.summary;
        context.executionPlan = planResult.plan;
        context.toolsAvailable = planResult.relevantTools;
        
        // Adjust max steps based on estimated steps from plan
        const estimatedSteps = Math.max(planResult.estimatedSteps, 2); // Minimum 2 steps
        const adjustedMaxSteps = Math.min(estimatedSteps + 2, this.agentConfig.maxToolCalls); // Add buffer, but respect limit
        context.maxSteps = adjustedMaxSteps;
        
        console.log(`📋 Plan generated:`, {
          summary: planResult.summary.substring(0, 100) + '...',
          estimatedSteps: planResult.estimatedSteps,
          adjustedMaxSteps,
          relevantTools: planResult.relevantTools
        });
        
        if (onContentChunk) {
          onContentChunk(`**AGENT_STATUS:PLAN_CREATED**\n**EXECUTION_PLAN:**\n${planResult.plan}\n\n`);
        }
        
      } catch (planError) {
        console.warn('⚠️ Failed to generate tools plan, continuing with default approach:', planError);
        if (onContentChunk) {
          onContentChunk('⚠️ **Planning failed, proceeding with adaptive approach...**\n\n');
        }
      }
    }
    
    // Ensure we always make at least one call, even if maxSteps is 0
    // If tools are available, ensure at least 2 steps (initial call + follow-up after tools)
    const minStepsNeeded = tools.length > 0 ? 2 : 1;
    const actualMaxSteps = 25; // Hardcoded to 25 steps as requested
    console.log(`🔧 Set maxSteps to ${actualMaxSteps} (hardcoded, originally ${context.maxSteps}, min needed: ${minStepsNeeded} due to ${tools.length} tools available)`);

    // STEP 2: Update system prompt with planning information
    const enhancedSystemPrompt = this.buildEnhancedSystemPrompt(
      conversationMessages[0]?.content, // Original system prompt
      tools, 
      context
    );
    
    // Replace the first system message with enhanced prompt
    if (conversationMessages.length > 0 && conversationMessages[0].role === 'system') {
      conversationMessages[0] = {
        ...conversationMessages[0],
        content: enhancedSystemPrompt
      };
    }

    // STEP 3: Main agent execution loop
    for (let step = 0; step < actualMaxSteps; step++) {
      // Check for stop signal at the beginning of each iteration
      if (this.shouldStopExecution) {
        console.log(`🛑 Stop signal detected - halting autonomous execution at step ${step + 1}`);
        
        if (onContentChunk) {
          onContentChunk(`\n🛑 **Execution stopped by user at step ${step + 1}**\n\n`);
        }
        
        responseContent += `\n\n🛑 **Execution stopped by user at step ${step + 1}**\n`;
        break;
      }
      
      context.currentStep = step;
      
      console.log(`🔄 Autonomous agent step ${step + 1}/${actualMaxSteps} starting...`);
      console.log(`📝 Current conversation messages:`, conversationMessages.length);
      console.log(`🛠️ Available tools:`, tools.length);
      
      try {
        if (onContentChunk && this.agentConfig.enableProgressTracking && step > 0) {
          onContentChunk(`\n**AGENT_STATUS:STEP_${step + 1}**\n`);
        }

        let stepResponse;
        let finishReason = '';

        console.log(`🚀 About to make LLM call with model: ${modelId}`);
        console.log(`⚙️ Options:`, options);
        console.log(`🔧 Streaming enabled:`, config.features.enableStreaming);

        // Try streaming first if enabled
        if (config.features.enableStreaming) {
          // Check if we should disable streaming for this provider when tools are present
          const shouldDisableStreamingForTools = this.shouldDisableStreamingForTools(tools);
          
          if (shouldDisableStreamingForTools) {
            console.log(`🔄 Disabling streaming for ${this.currentProvider?.type} provider with tools present`);
            if (onContentChunk) {
              onContentChunk('⚠️ Switching to non-streaming mode for better tool support with this provider...\n\n');
            }
            // Use non-streaming mode
            stepResponse = await this.client!.sendChat(modelId, conversationMessages, options, tools);
            const stepContent = stepResponse.message?.content || '';
            responseContent += stepContent;
            totalTokens = stepResponse.usage?.total_tokens || 0;
            
            if (onContentChunk && stepContent) {
              onContentChunk(stepContent);
            }
            console.log(`✅ Non-streaming completed. Content: ${stepContent.length} chars, Tool calls: ${stepResponse.message?.tool_calls?.length || 0}`);
          } else {
            // Use streaming mode
            try {
              console.log(`📡 Starting streaming chat...`);
              const collectedToolCalls: any[] = [];
              let stepContent = '';

              for await (const chunk of this.client!.streamChat(modelId, conversationMessages, options, tools)) {
                // console.log(`📦 [STREAM-DEBUG] Received chunk:`, JSON.stringify(chunk, null, 2));
                if (chunk.message?.content) {
                  stepContent += chunk.message.content;
                  if (onContentChunk) {
                    onContentChunk(chunk.message.content);
                  }
                }

                // Collect tool calls
                if (chunk.message?.tool_calls) {
                  console.log(`🔧 [STREAM] Processing tool calls in chunk:`, chunk.message.tool_calls);
                  for (const toolCall of chunk.message.tool_calls) {
                    console.log(`🔧 [STREAM] Processing individual tool call:`, toolCall);
                    
                    // Skip tool calls without valid IDs or names
                    if (!toolCall.id && !toolCall.function?.name) {
                      console.log(`⚠️ [STREAM] Skipping tool call without ID or name:`, toolCall);
                      continue;
                    }
                    
                    let existingCall = collectedToolCalls.find(c => c.id === toolCall.id);
                    if (!existingCall) {
                      existingCall = {
                        id: toolCall.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        type: toolCall.type || 'function',
                        function: { name: '', arguments: '' }
                      };
                      collectedToolCalls.push(existingCall);
                      console.log(`✅ [STREAM] Created new tool call:`, existingCall);
                    }
                    
                    // Update function name if provided
                    if (toolCall.function?.name) {
                      console.log(`🔧 [STREAM] Updating function name from "${existingCall.function.name}" to "${toolCall.function.name}"`);
                      existingCall.function.name = toolCall.function.name;
                    }
                    
                    // Accumulate arguments if provided
                    if (toolCall.function?.arguments) {
                      console.log(`🔧 [STREAM] Accumulating arguments: "${existingCall.function.arguments}" + "${toolCall.function.arguments}"`);
                      existingCall.function.arguments += toolCall.function.arguments;
                      console.log(`🔧 [STREAM] New accumulated arguments: "${existingCall.function.arguments}"`);
                    }
                    
                    console.log(`📊 [STREAM] Current state of existingCall:`, existingCall);
                  }
                  console.log(`📊 [STREAM] Current collectedToolCalls:`, collectedToolCalls);
                }

                if (chunk.finish_reason) {
                  finishReason = chunk.finish_reason;
                  console.log(`🏁 Stream finished with reason:`, finishReason);
                }
                if (chunk.usage?.total_tokens) {
                  totalTokens = chunk.usage.total_tokens;
                  finalUsage = chunk.usage;
                }
                if (chunk.timings) {
                  finalTimings = chunk.timings;
                }
              }

              stepResponse = {
                message: {
                  content: stepContent,
                  tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
                },
                usage: { total_tokens: totalTokens }
              };
              responseContent += stepContent;
              console.log(`✅ Streaming completed. Content length: ${stepContent.length}, Tool calls: ${collectedToolCalls.length}`);
              console.log(`📊 [STREAM] Final collectedToolCalls:`, JSON.stringify(collectedToolCalls, null, 2));

              // Filter out incomplete tool calls
              if (stepResponse.message?.tool_calls) {
                stepResponse.message.tool_calls = stepResponse.message.tool_calls.filter(toolCall => {
                  // Must have a valid function name
                  if (!toolCall.function?.name || toolCall.function.name.trim() === '') {
                    console.warn('⚠️ Filtering out tool call with empty function name:', toolCall);
                    return false;
                  }
                  
                  // Must have valid arguments (at least empty object)
                  if (typeof toolCall.function.arguments !== 'string') {
                    console.warn('⚠️ Filtering out tool call with invalid arguments type:', toolCall);
                    return false;
                  }
                  
                  // Try to parse arguments to ensure they're valid JSON
                  try {
                    JSON.parse(toolCall.function.arguments || '{}');
                    return true;
                  } catch (parseError) {
                    console.warn('⚠️ Filtering out tool call with invalid JSON arguments:', toolCall, parseError);
                    return false;
                  }
                });
                
                // If no valid tool calls remain, remove the tool_calls property
                if (stepResponse.message.tool_calls.length === 0) {
                  stepResponse.message.tool_calls = undefined;
                }
              }

            } catch (streamError: any) {
              console.error(`❌ Streaming error:`, streamError);
              // Fallback to non-streaming if streaming fails with tools
              const errorMessage = streamError.message?.toLowerCase() || '';
              if (errorMessage.includes('stream') && errorMessage.includes('tool') && tools.length > 0) {
                console.log(`🔄 Falling back to non-streaming mode...`);
                if (onContentChunk) {
                  onContentChunk('\n⚠️ Switching to non-streaming mode for tool support... (Probably due to your server not supporting streaming with tools)\n\n');
                }
                stepResponse = await this.client!.sendChat(modelId, conversationMessages, options, tools);
                responseContent += stepResponse.message?.content || '';
                totalTokens = stepResponse.usage?.total_tokens || 0;
                if (stepResponse.usage) finalUsage = stepResponse.usage;
                if (stepResponse.timings) finalTimings = stepResponse.timings;
                console.log(`✅ Non-streaming fallback completed. Content: ${stepResponse.message?.content?.length || 0} chars`);
              } else {
                throw streamError;
              }
            }
          }
        } else {
          // Non-streaming mode
          console.log(`📞 Making non-streaming chat call...`);
          stepResponse = await this.client!.sendChat(modelId, conversationMessages, options, tools);
          const stepContent = stepResponse.message?.content || '';
          responseContent += stepContent;
          totalTokens = stepResponse.usage?.total_tokens || 0;
          if (stepResponse.usage) finalUsage = stepResponse.usage;
          if (stepResponse.timings) finalTimings = stepResponse.timings;
          
          console.log(`✅ Non-streaming completed. Content: ${stepContent.length} chars, Tool calls: ${stepResponse.message?.tool_calls?.length || 0}`);
          
          if (onContentChunk && stepContent) {
            onContentChunk(stepContent);
          }
        }

        console.log(`📊 Step ${step + 1} response:`, {
          contentLength: stepResponse.message?.content?.length || 0,
          toolCallsCount: stepResponse.message?.tool_calls?.length || 0,
          finishReason
        });

        // Handle tool calls with retry mechanism
        if (stepResponse.message?.tool_calls && stepResponse.message.tool_calls.length > 0) {
          console.log(`🔧 Processing ${stepResponse.message.tool_calls.length} tool calls...`);
          console.log(`🔧 Tool call IDs:`, stepResponse.message.tool_calls.map((tc: any) => ({ id: tc.id, name: tc.function?.name })));
          console.log(`🔧 Already processed IDs:`, Array.from(processedToolCallIds));
          
          // Show user-friendly tool execution message
          const toolNames = stepResponse.message.tool_calls
            .map((tc: any) => tc.function?.name)
            .filter((name: string) => name)
            .map((name: string) => {
              // Convert tool names to user-friendly descriptions
              if (name.includes('github')) return 'GitHub';
              if (name.includes('file') || name.includes('read') || name.includes('write')) return 'file operations';
              if (name.includes('terminal') || name.includes('command')) return 'terminal commands';
              if (name.includes('search')) return 'search';
              if (name.includes('web') || name.includes('http')) return 'web requests';
              return name.replace(/^mcp_/, '').replace(/_/g, ' ');
            });
          
          const uniqueToolNames = [...new Set(toolNames)];
          const toolDescription = uniqueToolNames.length > 0 
            ? uniqueToolNames.join(', ')
            : 'tools';
          
          if (onContentChunk) {
            onContentChunk(`\n🔧 **Using ${toolDescription}...**\n\n`);
          }

          // Add assistant message with tool calls
          const assistantMessage = {
            role: 'assistant' as const,
            content: stepResponse.message.content || '',
            tool_calls: stepResponse.message.tool_calls
          };
          conversationMessages.push(assistantMessage);
          
          // Record execution step (tool results will be added after execution)
          this.recordExecutionStep(step, assistantMessage, stepResponse.message.tool_calls);

          // Execute tools with enhanced retry logic
          const toolResults = await this.executeToolCallsWithRetry(
            stepResponse.message.tool_calls, 
            context,
            onContentChunk
          );

          // Add tool results to conversation with deduplication
          // IMPORTANT: OpenAI requires a tool message for EVERY tool call ID, even if the tool fails
          for (const toolCall of stepResponse.message.tool_calls) {
            // Check if we've already processed this tool call ID
            if (processedToolCallIds.has(toolCall.id)) {
              console.warn(`⚠️ Skipping duplicate tool call ID: ${toolCall.id} for tool: ${toolCall.function?.name}`);
              continue;
            }

            // Mark this tool call ID as processed
            processedToolCallIds.add(toolCall.id);

            // Find the corresponding result for this tool call
            const result = toolResults.find(r => r.toolName === toolCall.function?.name);
            
            if (result) {
              // Use the processed tool message if available, otherwise fallback to basic format
              if (result.toolMessage) {
                // Use the comprehensive tool message with images and proper formatting
                const toolMessage = {
                  ...result.toolMessage,
                  tool_call_id: toolCall.id
                };
                conversationMessages.push(toolMessage);
                console.log(`✅ Added MCP tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              } else {
                // Fallback to basic format for non-MCP tools
                // Ensure we always have valid content for OpenAI
                let content: string;
                if (result.success && result.result !== undefined && result.result !== null) {
                  content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
                } else {
                  // For failed tools or tools with no result
                  content = result.error || `Tool ${result.toolName} execution failed`;
                }
                
                const toolMessage = {
                  role: 'tool' as const,
                  content: content,
                  name: result.toolName,
                  tool_call_id: toolCall.id
                };
                conversationMessages.push(toolMessage);
                console.log(`✅ Added basic tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              }
            } else {
              // No result found for this tool call - create a failure message
              // This ensures every tool call ID has a corresponding tool message
              console.warn(`⚠️ No result found for tool call ${toolCall.id} (${toolCall.function?.name}), creating failure message`);
              
              const failureMessage = {
                role: 'tool' as const,
                content: `Tool execution failed: No result returned for ${toolCall.function?.name || 'unknown tool'}`,
                name: toolCall.function?.name || 'unknown_tool',
                tool_call_id: toolCall.id
              };
              conversationMessages.push(failureMessage);
              console.log(`✅ Added failure tool message for ${toolCall.function?.name} with tool_call_id: ${toolCall.id}`);
            }
          }

          allToolResults.push(...toolResults);
          
          // Update execution step with tool results
          // Tool results are not stored in execution steps to save localStorage space
          // Assistant messages already contain processed information from tool results
          
          console.log(`🔧 After processing tools, conversation has ${conversationMessages.length} messages`);
          console.log(`🔧 Processed tool call IDs now:`, Array.from(processedToolCallIds));

          // Show completion message with summary
          const successCount = toolResults.filter(r => r.success).length;
          const failCount = toolResults.filter(r => !r.success).length;
          
          if (onContentChunk) {
            if (failCount === 0) {
              onContentChunk(`✅ **Completed successfully**\n\n`);
            } else {
              onContentChunk(`✅ **Completed** (${successCount} successful, ${failCount} failed)\n\n`);
            }
          }

          console.log(`🔄 Continuing to next step after tool execution...`);
          console.log(`📊 Current step: ${step}, actualMaxSteps: ${actualMaxSteps}, will continue: ${step + 1 < actualMaxSteps}`);
          
          // Removed per-step verification - now only runs once at the end
          
          // Continue to next iteration for follow-up response
          continue;
        }

        console.log(`🏁 No tool calls found, autonomous agent execution complete.`);
        // If no tool calls, we're done
        break;

      } catch (error) {
        console.error(`❌ Agent step ${step + 1} failed:`, error);
        
        // Check if this is a duplicate tool_call_id error
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Duplicate value for \'tool_call_id\'') || errorMessage.includes('duplicate')) {
          console.error(`🚨 Detected duplicate tool_call_id error. Processed IDs:`, Array.from(processedToolCallIds));
          
          if (onContentChunk) {
            onContentChunk(`\n❌ **Error**: Duplicate tool call detected. This indicates a system issue that has been logged for debugging.\n\n`);
          }
          
          // Try to recover by clearing processed IDs and continuing
          processedToolCallIds.clear();
          console.log(`🔄 Cleared processed tool call IDs, attempting to continue...`);
          
          // If we have tool results, try to provide a meaningful response
          if (allToolResults.length > 0) {
            const successfulResults = allToolResults.filter(r => r.success);
            const failedResults = allToolResults.filter(r => !r.success);
            
            let errorSummary = `I encountered a technical issue while processing the tools, but I was able to execute ${successfulResults.length} tools successfully`;
            if (failedResults.length > 0) {
              errorSummary += ` and ${failedResults.length} tools failed`;
            }
            errorSummary += '. Here\'s what I found:\n\n';
            
            // Add successful results
            for (const result of successfulResults) {
              if (result.result) {
                errorSummary += `**${result.toolName}**: ${typeof result.result === 'string' ? result.result : JSON.stringify(result.result)}\n\n`;
              }
            }
            
            // Add failed results
            for (const result of failedResults) {
              errorSummary += `**${result.toolName}** (failed): ${result.error || 'Unknown error'}\n\n`;
            }
            
            responseContent += errorSummary;
            
            if (onContentChunk) {
              onContentChunk(errorSummary);
            }
          }
          
          break; // Exit the loop to prevent further errors
        }
        
        if (onContentChunk) {
          onContentChunk(`\n❌ **Error in step ${step + 1}**: ${errorMessage}\n\n`);
        }

        // Try to recover or break if too many failures
        if (step >= this.agentConfig.maxRetries) {
          console.log(`💥 Max retries reached, breaking out of agent loop`);
          
          // Add error notification for max retries reached
          addErrorNotification(
            'Autonomous Mode Error',
            `Maximum retries reached. Some operations may have failed.`,
            8000
          );
          
          // Provide a meaningful error message to the user
          const errorSummary = `I encountered repeated errors during execution. Here's what I was able to accomplish:\n\n`;
          let finalSummary = errorSummary;
          
          if (allToolResults.length > 0) {
            const successfulResults = allToolResults.filter(r => r.success);
            const failedResults = allToolResults.filter(r => !r.success);
            
            finalSummary += `✅ Successfully executed ${successfulResults.length} tools\n`;
            finalSummary += `❌ Failed to execute ${failedResults.length} tools\n\n`;
            
            if (successfulResults.length > 0) {
              finalSummary += `**Successful results:**\n`;
              for (const result of successfulResults) {
                if (result.result) {
                  finalSummary += `- **${result.toolName}**: ${typeof result.result === 'string' ? result.result.substring(0, 200) : JSON.stringify(result.result).substring(0, 200)}...\n`;
                }
              }
            }
          } else {
            finalSummary += `Unfortunately, I wasn't able to execute any tools successfully due to technical issues.`;
          }
          
          responseContent += finalSummary;
          
          if (onContentChunk) {
            onContentChunk(finalSummary);
          }
          
          break;
        }
      }
    }

    console.log(`🎯 Autonomous agent execution completed. Response content length: ${responseContent.length}, Tool results: ${allToolResults.length}`);
    console.log(`🔚 Loop ended at step ${context.currentStep + 1}/${actualMaxSteps}`);

    // 🔍 POST-EXECUTION COMPLETION VERIFICATION LOOP - Check if task is actually complete and continue until 100%
    if (allToolResults.length > 0) {
      let verificationLoop = 0;
      const maxVerificationLoops = 5; // Prevent infinite loops
      let currentCompletionAnalysis: CompletionAnalysis | null = null;
      
      while (verificationLoop < maxVerificationLoops) {
        // Check for stop signal in verification loop
        if (this.shouldStopExecution) {
          console.log(`🛑 Stop signal detected - halting verification loop at iteration ${verificationLoop}`);
          
          if (onContentChunk) {
            onContentChunk(`\n🛑 **Verification stopped by user**\n\n`);
          }
          
          responseContent += `\n\n🛑 **Verification stopped by user**\n`;
          break;
        }
        
        verificationLoop++;
        
        try {
          console.log(`🔍 ====== VERIFICATION LOOP ${verificationLoop}/${maxVerificationLoops} STARTING ======`);
          console.log(`🔍 Total Steps: ${context.currentStep + 1}/${actualMaxSteps}`);
          console.log(`🔍 Original Query: "${context.originalQuery}"`);
          console.log(`🔍 Tool Results Count: ${allToolResults.length}`);
          console.log(`🔍 Successful Tools: ${allToolResults.filter(r => r.success).length}`);
          console.log(`🔍 Failed Tools: ${allToolResults.filter(r => !r.success).length}`);
          
          const completionAnalysis = await this.verifyTaskCompletion(
            context.originalQuery,
            allToolResults,
            context,
            context.currentStep,
            modelId,
            onContentChunk
          );
          
          currentCompletionAnalysis = completionAnalysis;
          
          console.log(`🔍 ====== VERIFICATION LOOP ${verificationLoop} COMPLETED ======`);
          console.log(`🔍 📊 Completion analysis:`, {
            status: completionAnalysis.completionStatus,
            confidence: completionAnalysis.confidenceScore,
            missingComponents: completionAnalysis.missingComponents.length,
            nextActions: completionAnalysis.nextActions.length
          });
          
          // Add verification results to UI
          if (onContentChunk) {
            if (completionAnalysis.completionStatus === 'complete') {
              onContentChunk(`\n🎉 **Task verified as COMPLETE!** (${completionAnalysis.confidenceScore}% confidence)\n\n`);
            } else if (completionAnalysis.completionStatus === 'partial') {
              onContentChunk(`\n🔍 **Task partially complete** (${completionAnalysis.confidenceScore}% confidence)\n`);
              if (completionAnalysis.missingComponents.length > 0) {
                onContentChunk(`**Missing components**: ${completionAnalysis.missingComponents.map(m => m.description).join(', ')}\n`);
              }
            } else {
              onContentChunk(`\n⚠️ **Task may be incomplete** (${completionAnalysis.confidenceScore}% confidence)\n`);
              if (completionAnalysis.missingComponents.length > 0) {
                onContentChunk(`**Missing components**: ${completionAnalysis.missingComponents.map(m => m.description).join(', ')}\n`);
              }
            }
          }
          
          // 🎯 INTELLIGENT COMPLETION DECISION - Check if task is complete or needs continuation
          if (completionAnalysis.completionStatus === 'complete' || completionAnalysis.confidenceScore >= 95) {
            console.log(`🔍 ✅ DECISION: Task verified as complete (${completionAnalysis.confidenceScore}% confidence) - finalizing response`);
            responseContent += `\n\n**✅ Task Verification Complete** (${completionAnalysis.confidenceScore}% confidence)\n`;
            break; // Exit the verification loop
            
          } else if ((completionAnalysis.completionStatus === 'partial' || completionAnalysis.completionStatus === 'incomplete') && 
                     completionAnalysis.nextActions.length > 0 && 
                     completionAnalysis.confidenceScore < 95 &&
                     context.currentStep < (actualMaxSteps - 2)) {
            
            console.log(`🔍 🔄 DECISION: Task ${completionAnalysis.completionStatus} (${completionAnalysis.confidenceScore}% confidence) - RESUMING EXECUTION (Loop ${verificationLoop})`);
            console.log(`🔍 📋 Missing components: ${completionAnalysis.missingComponents.length}`);
            console.log(`🔍 📋 Next actions: ${completionAnalysis.nextActions.length}`);
            console.log(`🔍 📊 Current step: ${context.currentStep}, Max steps: ${actualMaxSteps}`);
            
            if (onContentChunk) {
              onContentChunk(`\n🔄 **Task verification detected missing work - continuing execution (Loop ${verificationLoop})...**\n`);
              if (completionAnalysis.nextActions.length > 0) {
                onContentChunk(`**Next actions**: ${completionAnalysis.nextActions.map(a => a.action).join(', ')}\n\n`);
              }
            }
            
            // Add specific guidance for continuation
            const continuationPrompt = `\n\n**TASK CONTINUATION REQUIRED (Verification Loop ${verificationLoop})**

Based on verification analysis, the task is only ${completionAnalysis.confidenceScore}% complete. Please continue execution to complete these remaining actions:

${completionAnalysis.nextActions.map((action, i) => `${i + 1}. ${action.action} (using: ${action.toolsNeeded?.join(', ') || 'appropriate tools'})`).join('\n')}

${completionAnalysis.missingComponents.length > 0 ? `\n**Missing components to complete:**\n${completionAnalysis.missingComponents.map(m => `• ${m.description} (priority: ${m.priority})`).join('\n')}` : ''}

Continue with autonomous execution to complete these remaining tasks. The goal is to reach 100% completion.`;
            
            conversationMessages.push({
              role: 'system',
              content: continuationPrompt
            });
            
            // RESUME AUTONOMOUS EXECUTION for remaining steps
            const remainingSteps = actualMaxSteps - context.currentStep - 1;
            const continuationSteps = Math.min(remainingSteps, completionAnalysis.nextActions.length + 2);
            
            console.log(`🔍 🚀 RESUMING autonomous execution for ${continuationSteps} more steps...`);
            
            // Continue the autonomous loop for remaining actions
            let continuationExecuted = false;
            for (let contStep = 0; contStep < continuationSteps; contStep++) {
              // Check for stop signal in continuation loop
              if (this.shouldStopExecution) {
                console.log(`🛑 Stop signal detected - halting continuation at step ${contStep + 1}`);
                
                if (onContentChunk) {
                  onContentChunk(`\n🛑 **Continuation stopped by user**\n\n`);
                }
                
                break;
              }
              
              const totalStep = context.currentStep + 1 + contStep;
              context.currentStep = totalStep;
              
              console.log(`🔍 🔄 Continuation step ${contStep + 1}/${continuationSteps} (total step ${totalStep + 1}/${actualMaxSteps})`);
              
              try {
                if (onContentChunk) {
                  onContentChunk(`\n**Continuing execution - Step ${contStep + 1}**\n`);
                }

                // Make continuation call with proper streaming pattern
                let contResponse: any;
                if (config.features.enableStreaming) {
                  // Handle streaming with tool call collection (similar to main streaming logic)
                  const collectedToolCalls: any[] = [];
                  let stepContent = '';
                  
                  for await (const chunk of this.client!.streamChat(modelId, conversationMessages, options, tools)) {
                    if (chunk.message?.content) {
                      stepContent += chunk.message.content;
                      if (onContentChunk) {
                        onContentChunk(chunk.message.content);
                      }
                    }

                    // Collect tool calls from chunks
                    if (chunk.message?.tool_calls) {
                      for (const toolCall of chunk.message.tool_calls) {
                        if (!toolCall.id && !toolCall.function?.name) continue;
                        
                        let existingCall = collectedToolCalls.find(c => c.id === toolCall.id);
                        if (!existingCall) {
                          existingCall = {
                            id: toolCall.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            type: toolCall.type || 'function',
                            function: { name: '', arguments: '' }
                          };
                          collectedToolCalls.push(existingCall);
                        }
                        
                        if (toolCall.function?.name) {
                          existingCall.function.name = toolCall.function.name;
                        }
                        if (toolCall.function?.arguments) {
                          existingCall.function.arguments += toolCall.function.arguments;
                        }
                      }
                    }
                  }
                  
                  contResponse = {
                    message: {
                      content: stepContent,
                      tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
                    }
                  };
                  responseContent += stepContent;
                } else {
                  contResponse = await this.client!.sendChat(modelId, conversationMessages, options, tools);
                  const contContent = contResponse.message?.content || '';
                  responseContent += contContent;
                  if (onContentChunk && contContent) {
                    onContentChunk(contContent);
                  }
                }

                // Handle any tool calls in continuation
                if (contResponse.message?.tool_calls && contResponse.message.tool_calls.length > 0) {
                  console.log(`🔍 🔧 Processing ${contResponse.message.tool_calls.length} tool calls in continuation...`);
                  
                  const contAssistantMessage = {
                    role: 'assistant' as const,
                    content: contResponse.message.content || '',
                    tool_calls: contResponse.message.tool_calls
                  };
                  conversationMessages.push(contAssistantMessage);
                  
                  // Record continuation execution step
                  this.recordExecutionStep(totalStep, contAssistantMessage, contResponse.message.tool_calls, undefined, verificationLoop);

                  const contToolResults = await this.executeToolCallsWithRetry(
                    contResponse.message.tool_calls, 
                    context,
                    onContentChunk
                  );

                  // Add tool results to conversation
                  for (const toolCall of contResponse.message.tool_calls) {
                    const result = contToolResults.find(r => r.toolName === toolCall.function?.name);
                    if (result) {
                      const toolMessage = {
                        role: 'tool' as const,
                        content: typeof result.result === 'string' ? result.result : JSON.stringify(result.result),
                        name: toolCall.function?.name || 'unknown_tool',
                        tool_call_id: toolCall.id
                      };
                      conversationMessages.push(toolMessage);
                    }
                  }

                  allToolResults.push(...contToolResults);
                  continuationExecuted = true;
                  
                  // Update continuation execution step with tool results
                  if (this.executionSteps.length > 0) {
                    const lastStep = this.executionSteps[this.executionSteps.length - 1];
                    if (lastStep.stepNumber === totalStep) {
                      lastStep.toolResults = contToolResults;
                      // Update localStorage
                      try {
                        const stored = localStorage.getItem(`clara_execution_${this.currentExecutionId}`);
                        if (stored) {
                          const executionHistory: ExecutionHistory = JSON.parse(stored);
                          executionHistory.steps = this.executionSteps;
                          localStorage.setItem(`clara_execution_${this.currentExecutionId}`, JSON.stringify(executionHistory));
                        }
                      } catch (error) {
                        console.warn('Failed to update continuation tool results in execution step:', error);
                      }
                    }
                  }
                } else {
                  // No tool calls, we're done with continuation
                  console.log(`🔍 ✅ Continuation completed - no more tool calls needed`);
                  break;
                }

              } catch (contError) {
                console.error(`🔍 ❌ Continuation step ${contStep + 1} failed:`, contError);
                if (onContentChunk) {
                  onContentChunk(`\n❌ **Continuation step failed** - completing with current progress\n`);
                }
                break;
              }
            }
            
            console.log(`🔍 ✅ CONTINUATION COMPLETED - now re-verifying in next loop iteration`);
            if (onContentChunk) {
              onContentChunk(`\n✅ **Continuation execution completed - re-verifying...**\n\n`);
            }
            
            // If no continuation was executed, exit the loop to prevent infinite loops
            if (!continuationExecuted) {
              console.log(`🔍 ⚠️ No continuation executed - exiting verification loop`);
              break;
            }
            
            // Continue to next verification loop iteration
            continue;
            
          } else {
            console.log(`🔍 ⚠️ DECISION: Task ${completionAnalysis.completionStatus} (${completionAnalysis.confidenceScore}% confidence) but cannot continue (step limit or other constraints)`);
            responseContent += `\n\n**🔍 Task Verification**: ${completionAnalysis.completionStatus === 'incomplete' ? 'Incomplete' : 'Partially complete'} (${completionAnalysis.confidenceScore}% confidence)\n`;
            if (completionAnalysis.missingComponents.length > 0) {
              responseContent += `**Missing components**: ${completionAnalysis.missingComponents.map(m => m.description).join(', ')}\n`;
            }
            break; // Exit the verification loop
          }
          
        } catch (verificationError) {
          console.error(`🔍 ❌ VERIFICATION LOOP ${verificationLoop} FAILED:`, verificationError);
          if (onContentChunk) {
            onContentChunk(`\n⚠️ **Verification loop ${verificationLoop} failed** - ${verificationError instanceof Error ? verificationError.message : 'Unknown error'}\n`);
          }
          
          // If this is the first verification attempt, fall back to basic completion
          if (verificationLoop === 1) {
            responseContent += `\n\n**⚠️ Verification Note**: Task completed but verification system encountered an error\n`;
          }
          break; // Exit the verification loop
        }
      }
      
      // Final status based on last verification
      if (verificationLoop >= maxVerificationLoops) {
        console.log(`🔍 ⚠️ VERIFICATION LOOP LIMIT REACHED (${maxVerificationLoops} loops) - finalizing with current status`);
        if (onContentChunk) {
          onContentChunk(`\n⚠️ **Verification loop limit reached** - Task completed with current progress\n`);
        }
        responseContent += `\n\n**🔍 Task Status**: Verification loop completed (${verificationLoop - 1} iterations)\n`;
        if (currentCompletionAnalysis) {
          responseContent += `**Final confidence**: ${currentCompletionAnalysis.confidenceScore}% - ${currentCompletionAnalysis.completionStatus}\n`;
        }
      }
      
      console.log(`🔍 ====== VERIFICATION LOOP SYSTEM COMPLETED ======`);
      console.log(`🔍 📊 Final verification stats:`, {
        totalLoops: verificationLoop,
        maxLoops: maxVerificationLoops,
        finalConfidence: currentCompletionAnalysis?.confidenceScore || 0,
        finalStatus: currentCompletionAnalysis?.completionStatus || 'unknown'
      });
      
      // Finalize execution tracking
      if (currentCompletionAnalysis) {
        this.finalizeExecutionTracking(
          currentCompletionAnalysis.completionStatus,
          currentCompletionAnalysis.confidenceScore
        );
      }
    }

    // Create comprehensive summary including execution steps and tool results
    let finalContent = responseContent;
    
    // Add detailed execution summary to final response
    const allExecutionSteps = this.getAllExecutionSteps();
    if (allExecutionSteps.length > 0) {
      const executionSummary = this.createExecutionSummary(allExecutionSteps, allToolResults);
      if (executionSummary) {
        finalContent += (finalContent ? '\n\n' : '') + executionSummary;
      }
    } else if (allToolResults.length > 0) {
      // Fallback to basic tool summary if execution steps not available
      const toolSummary = this.createToolResultSummary(allToolResults);
      if (toolSummary) {
        finalContent += (finalContent ? '\n\n' : '') + toolSummary;
      }
    }

    // Create final Clara message with better error handling
    const claraMessage: ClaraMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: finalContent || 'I completed the autonomous agent execution, but encountered some technical issues. Please try again or contact support if the problem persists.',
      timestamp: new Date(),
      metadata: {
        model: `${config.provider}:${modelId}`,
        tokens: totalTokens,
        usage: finalUsage,
        timings: finalTimings,
        temperature: config.parameters.temperature,
        toolsUsed: allToolResults.map(tc => tc.toolName),
        agentSteps: context.currentStep + 1,
        autonomousMode: true,
        processedToolCallIds: Array.from(processedToolCallIds),
        toolResultsSummary: {
          total: allToolResults.length,
          successful: allToolResults.filter(r => r.success).length,
          failed: allToolResults.filter(r => !r.success).length
        },
        planningUsed: !!context.toolsSummary,
        executionPlan: context.executionPlan
      }
    };

    // Add artifacts if any were generated from tool calls
    if (allToolResults.length > 0) {
      claraMessage.artifacts = this.parseToolResultsToArtifacts(allToolResults);
    }

    // Store execution results in IndexedDB for future reference
    try {
      const executionId = `autonomous_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const taskType = this.determineTaskType(context.originalQuery);
      
      const executionResults = {
        originalQuery: context.originalQuery,
        taskType,
        toolResults: allToolResults,
        completedSteps: context.currentStep + 1,
        finalMessage: claraMessage.content,
        artifacts: claraMessage.artifacts || [],
        metadata: claraMessage.metadata,
        timestamp: Date.now()
      };
      
      await this.recoveryService.storeExecutionResult(executionId, taskType, executionResults);
      console.log(`💾 [EXECUTION] Stored autonomous execution results: ${executionId}`);
    } catch (storageError) {
      console.warn('⚠️ Failed to store execution results:', storageError);
    }

    return claraMessage;
  }

  /**
   * Execute tool calls with enhanced retry mechanism and error correction
   */
  private async executeToolCallsWithRetry(
    toolCalls: any[], 
    context: AgentExecutionContext,
    onContentChunk?: (content: string) => void
  ): Promise<any[]> {
    const results = [];

    for (const toolCall of toolCalls) {
      const functionName = toolCall.function?.name;
      
      // Safely parse arguments with better error handling
      let args = {};
      try {
        if (typeof toolCall.function?.arguments === 'string') {
          const argsString = toolCall.function.arguments.trim();
          if (argsString === '' || argsString === 'null' || argsString === 'undefined') {
            args = {};
          } else {
            args = JSON.parse(argsString);
          }
        } else if (toolCall.function?.arguments && typeof toolCall.function.arguments === 'object') {
          args = toolCall.function.arguments;
        } else {
          args = {};
        }
      } catch (parseError) {
        console.warn(`⚠️ Failed to parse tool arguments for ${functionName}:`, parseError);
        console.warn(`⚠️ Raw arguments:`, toolCall.function?.arguments);
        if (onContentChunk) {
          onContentChunk(`⚠️ **Argument parsing failed for ${functionName}**: ${parseError}\n`);
        }
        results.push({
          toolName: functionName,
          success: false,
          error: `Failed to parse arguments: ${parseError}`
        });
        continue;
      }

      // Retry mechanism for each tool call
      let lastError = '';
      let success = false;
      let result = null;

      for (let attempt = 1; attempt <= this.agentConfig.maxRetries; attempt++) {
        try {
          // Track attempt
          const attemptRecord: ToolExecutionAttempt = {
            attempt,
            toolName: functionName,
            arguments: args,
            success: false,
            timestamp: new Date()
          };

          // Only show retry message for attempts > 1, and make it less verbose
          if (onContentChunk && attempt > 1) {
            onContentChunk(`🔄 **Retrying...** (${attempt}/${this.agentConfig.maxRetries})\n`);
          }

          // Check if this is an MCP tool call
          if (functionName?.startsWith('mcp_')) {
            const mcpToolCalls = claraMCPService.parseOpenAIToolCalls([toolCall]);
            
            if (mcpToolCalls.length > 0) {
              const mcpResult = await claraMCPService.executeToolCall(mcpToolCalls[0]);
              
              if (mcpResult.success) {
                // Process the MCP result comprehensively
                const processedResult = this.processMCPToolResult(mcpResult, functionName);
                
                result = {
                  toolName: functionName,
                  success: true,
                  result: processedResult.result,
                  artifacts: processedResult.artifacts,
                  images: processedResult.images,
                  toolMessage: processedResult.toolMessage,
                  metadata: {
                    type: 'mcp',
                    server: mcpToolCalls[0].server,
                    toolName: mcpToolCalls[0].name,
                    attempts: attempt,
                    ...mcpResult.metadata
                  }
                };
                success = true;
                attemptRecord.success = true;
                console.log(`✅ MCP tool ${functionName} succeeded on attempt ${attempt}:`, result);
              } else {
                lastError = mcpResult.error || 'MCP tool execution failed';
                attemptRecord.error = lastError;
                console.log(`❌ MCP tool ${functionName} failed on attempt ${attempt}:`, lastError);
              }
            } else {
              lastError = 'Failed to parse MCP tool call';
              attemptRecord.error = lastError;
            }
          } else {
            // Regular tool execution
            const claraTool = defaultTools.find(tool => tool.name === functionName || tool.id === functionName);
            
            if (claraTool) {
              const toolResult = await executeTool(claraTool.id, args);
              if (toolResult.success) {
                result = {
                  toolName: functionName,
                  success: true,
                  result: toolResult.result,
                  metadata: { attempts: attempt }
                };
                success = true;
                attemptRecord.success = true;
                console.log(`✅ Clara tool ${functionName} succeeded on attempt ${attempt}:`, result);
              } else {
                lastError = toolResult.error || 'Tool execution failed';
                attemptRecord.error = lastError;
                console.log(`❌ Clara tool ${functionName} failed on attempt ${attempt}:`, lastError);
              }
            } else {
              // Try database tools
              const dbTools = await db.getEnabledTools();
              const dbTool = dbTools.find(tool => tool.name === functionName);
              
              if (dbTool) {
                try {
                  const funcBody = `return (async () => {
                    ${dbTool.implementation}
                    return await implementation(args);
                  })();`;
                  const testFunc = new Function('args', funcBody);
                  const dbResult = await testFunc(args);
                  
                  result = {
                    toolName: functionName,
                    success: true,
                    result: dbResult,
                    metadata: { attempts: attempt }
                  };
                  success = true;
                  attemptRecord.success = true;
                  console.log(`✅ Database tool ${functionName} succeeded on attempt ${attempt}:`, result);
                } catch (dbError) {
                  lastError = dbError instanceof Error ? dbError.message : 'Database tool execution failed';
                  attemptRecord.error = lastError;
                  console.log(`❌ Database tool ${functionName} failed on attempt ${attempt}:`, lastError);
                }
              } else {
                lastError = `Tool '${functionName}' not found. Available tools: ${context.toolsAvailable.join(', ')}`;
                attemptRecord.error = lastError;
              }
            }
          }

          context.attempts.push(attemptRecord);

          if (success) {
            // Only show success message for retries (not first attempt)
            if (onContentChunk && attempt > 1) {
              onContentChunk(`✅ **Success**\n`);
            }
            break;
          }

          // Wait before retry
          if (attempt < this.agentConfig.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, this.agentConfig.retryDelay));
          }

        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Unknown error occurred';
          context.attempts.push({
            attempt,
            toolName: functionName,
            arguments: args,
            error: lastError,
            success: false,
            timestamp: new Date()
          });

          // Only show error details in console, not to user
          console.error(`❌ Tool ${functionName} attempt ${attempt} failed:`, lastError);
        }
      }

      // Add final result
      if (success && result) {
        console.log(`🎯 Final result for ${functionName}:`, result);
        results.push(result);
      } else {
        const finalResult = {
          toolName: functionName,
          success: false,
          error: lastError,
          metadata: { attempts: this.agentConfig.maxRetries }
        };
        console.log(`💥 Final failure for ${functionName}:`, finalResult);
        results.push(finalResult);
        
        // Only show failure message if all retries failed, and make it user-friendly
        if (onContentChunk) {
          const friendlyToolName = functionName
            .replace(/^mcp_/, '')
            .replace(/_/g, ' ')
            .toLowerCase();
          onContentChunk(`⚠️ **${friendlyToolName} failed** - will try alternative approach\n\n`);
        }
      }
    }

    console.log(`🔧 Autonomous tool execution summary: ${results.length} tools executed, ${results.filter(r => r.success).length} successful, ${results.filter(r => !r.success).length} failed`);
    return results;
  }

  /**
   * Execute standard chat workflow (non-autonomous mode)
   */
  private async executeStandardChat(
    modelId: string,
    messages: ChatMessage[],
    tools: Tool[],
    config: ClaraAIConfig,
    onContentChunk?: (content: string) => void
  ): Promise<ClaraMessage> {
    const options = {
      temperature: config.parameters.temperature,
      max_tokens: config.parameters.maxTokens,
      top_p: config.parameters.topP
    };

    let responseContent = '';
    let totalTokens = 0;
    let toolResults: any[] = [];
    let finalUsage: any = {};
    let finalTimings: any = {};

    try {
      let response;

      // Try streaming first if enabled
      if (config.features.enableStreaming) {
        // Check if we should disable streaming for this provider when tools are present
        const shouldDisableStreamingForTools = this.shouldDisableStreamingForTools(tools);
        
        if (shouldDisableStreamingForTools) {
          console.log(`🔄 Disabling streaming for ${this.currentProvider?.type} provider with tools present`);
          if (onContentChunk) {
            onContentChunk('⚠️ Switching to non-streaming mode for better tool support with this provider...\n\n');
          }
          // Use non-streaming mode
          response = await this.client!.sendChat(modelId, messages, options, tools);
          responseContent = response.message?.content || '';
          totalTokens = response.usage?.total_tokens || 0;
          finalUsage = response.usage || {};
          finalTimings = response.timings || {};
          
          if (onContentChunk && responseContent) {
            onContentChunk(responseContent);
          }
          console.log(`✅ Non-streaming completed. Content: ${responseContent.length} chars, Tool calls: ${response.message?.tool_calls?.length || 0}`);
        } else {
          // Use streaming mode
          try {
            const collectedToolCalls: any[] = [];
            let streamContent = '';

            for await (const chunk of this.client!.streamChat(modelId, messages, options, tools)) {
              // console.log(`📦 [STREAM-DEBUG] Received chunk:`, JSON.stringify(chunk, null, 2));
              if (chunk.message?.content) {
                streamContent += chunk.message.content;
                responseContent += chunk.message.content;
                if (onContentChunk) {
                  onContentChunk(chunk.message.content);
                }
              }

              // Collect tool calls
              if (chunk.message?.tool_calls) {
                console.log(`🔧 [STANDARD-STREAM] Processing tool calls in chunk:`, chunk.message.tool_calls);
                for (const toolCall of chunk.message.tool_calls) {
                  console.log(`🔧 [STANDARD-STREAM] Processing individual tool call:`, toolCall);
                  
                  // Skip tool calls without valid IDs or names
                  if (!toolCall.id && !toolCall.function?.name) {
                    console.log(`⚠️ [STANDARD-STREAM] Skipping tool call without ID or name:`, toolCall);
                    continue;
                  }
                  
                  let existingCall = collectedToolCalls.find(c => c.id === toolCall.id);
                  if (!existingCall) {
                    existingCall = {
                      id: toolCall.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      type: toolCall.type || 'function',
                      function: { name: '', arguments: '' }
                    };
                    collectedToolCalls.push(existingCall);
                    console.log(`✅ [STANDARD-STREAM] Created new tool call:`, existingCall);
                  }
                  
                  // Update function name if provided
                  if (toolCall.function?.name) {
                    console.log(`🔧 [STANDARD-STREAM] Updating function name from "${existingCall.function.name}" to "${toolCall.function.name}"`);
                    existingCall.function.name = toolCall.function.name;
                  }
                  
                  // Accumulate arguments if provided
                  if (toolCall.function?.arguments) {
                    console.log(`🔧 [STANDARD-STREAM] Accumulating arguments: "${existingCall.function.arguments}" + "${toolCall.function.arguments}"`);
                    existingCall.function.arguments += toolCall.function.arguments;
                    console.log(`🔧 [STANDARD-STREAM] New accumulated arguments: "${existingCall.function.arguments}"`);
                  }
                  
                  console.log(`📊 [STANDARD-STREAM] Current state of existingCall:`, existingCall);
                }
                console.log(`📊 [STANDARD-STREAM] Current collectedToolCalls:`, collectedToolCalls);
              }

              if (chunk.usage?.total_tokens) {
                totalTokens = chunk.usage.total_tokens;
                finalUsage = chunk.usage;
              }
              if (chunk.timings) {
                finalTimings = chunk.timings;
              }
            }

            response = {
              message: {
                content: streamContent,
                tool_calls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined
              },
              usage: { total_tokens: totalTokens }
            };

            // Filter out incomplete tool calls
            if (response.message?.tool_calls) {
              response.message.tool_calls = response.message.tool_calls.filter(toolCall => {
                // Must have a valid function name
                if (!toolCall.function?.name || toolCall.function.name.trim() === '') {
                  console.warn('⚠️ Filtering out tool call with empty function name:', toolCall);
                  return false;
                }
                
                // Must have valid arguments (at least empty object)
                if (typeof toolCall.function.arguments !== 'string') {
                  console.warn('⚠️ Filtering out tool call with invalid arguments type:', toolCall);
                  return false;
                }
                
                // Try to parse arguments to ensure they're valid JSON
                try {
                  JSON.parse(toolCall.function.arguments || '{}');
                  return true;
                } catch (parseError) {
                  console.warn('⚠️ Filtering out tool call with invalid JSON arguments:', toolCall, parseError);
                  return false;
                }
              });
              
              // If no valid tool calls remain, remove the tool_calls property
              if (response.message.tool_calls.length === 0) {
                response.message.tool_calls = undefined;
              }
            }

          } catch (streamError: any) {
            // Fallback to non-streaming if streaming fails with tools
            const errorMessage = streamError.message?.toLowerCase() || '';
            if (errorMessage.includes('stream') && errorMessage.includes('tool') && tools.length > 0) {
              if (onContentChunk) {
                onContentChunk('\n⚠️ Switching to non-streaming mode for tool support... (Probably due to your server not supporting streaming with tools)\n\n');
              }
              response = await this.client!.sendChat(modelId, messages, options, tools);
              responseContent = response.message?.content || '';
              totalTokens = response.usage?.total_tokens || 0;
              finalUsage = response.usage || {};
              finalTimings = response.timings || {};
              
              if (onContentChunk && responseContent) {
                onContentChunk(responseContent);
              }
            } else {
              throw streamError;
            }
          }
        }
      } else {
        // Non-streaming mode
        response = await this.client!.sendChat(modelId, messages, options, tools);
        responseContent = response.message?.content || '';
        totalTokens = response.usage?.total_tokens || 0;
        finalUsage = response.usage || {};
        finalTimings = response.timings || {};
        
        if (onContentChunk && responseContent) {
          onContentChunk(responseContent);
        }
      }

      // Handle tool calls if any (simple execution, no retry logic)
      if (response.message?.tool_calls && response.message.tool_calls.length > 0) {
        if (onContentChunk) {
          onContentChunk('\n\n🔧 **Executing tools...**\n\n');
        }

        toolResults = await this.executeToolCalls(response.message.tool_calls);

        if (onContentChunk) {
          onContentChunk('✅ **Tools executed**\n\n');
        }

        // After tool execution, make a follow-up request to process the results
        if (toolResults.length > 0) {
          console.log(`🔄 Making follow-up request to process ${toolResults.length} tool results`);
          
          // Build conversation with tool results
          const followUpMessages = [...messages];
          
          // Add the assistant's message with tool calls
          followUpMessages.push({
            role: 'assistant',
            content: response.message.content || '',
            tool_calls: response.message.tool_calls
          });
          
          // Add tool results - IMPORTANT: OpenAI requires a tool message for EVERY tool call ID
          for (const toolCall of response.message.tool_calls) {
            // Find the corresponding result for this tool call
            const result = toolResults.find(r => r.toolName === toolCall.function?.name);
            
            if (result) {
              // Use the processed tool message if available, otherwise fallback to basic format
              if (result.toolMessage) {
                // Use the comprehensive tool message with images and proper formatting
                const toolMessage = {
                  ...result.toolMessage,
                  tool_call_id: toolCall.id
                };
                followUpMessages.push(toolMessage);
                console.log(`✅ Added MCP tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              } else {
                // Fallback to basic format for non-MCP tools
                // Ensure we always have valid content for OpenAI
                let content: string;
                if (result.success && result.result !== undefined && result.result !== null) {
                  content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
                } else {
                  // For failed tools or tools with no result
                  content = result.error || `Tool ${result.toolName} execution failed`;
                }
                
                followUpMessages.push({
                  role: 'tool',
                  content: content,
                  name: result.toolName,
                  tool_call_id: toolCall.id
                });
                console.log(`✅ Added basic tool message for ${result.toolName} with tool_call_id: ${toolCall.id}`);
              }
            } else {
              // No result found for this tool call - create a failure message
              // This ensures every tool call ID has a corresponding tool message
              console.warn(`⚠️ No result found for tool call ${toolCall.id} (${toolCall.function?.name}), creating failure message`);
              
              followUpMessages.push({
                role: 'tool',
                content: `Tool execution failed: No result returned for ${toolCall.function?.name || 'unknown tool'}`,
                name: toolCall.function?.name || 'unknown_tool',
                tool_call_id: toolCall.id
              });
              console.log(`✅ Added failure tool message for ${toolCall.function?.name} with tool_call_id: ${toolCall.id}`);
            }
          }

          console.log(`📤 Sending follow-up request with ${followUpMessages.length} messages`);
          
          // Make follow-up request (always non-streaming to avoid complexity)
          try {
            const followUpResponse = await this.client!.sendChat(modelId, followUpMessages, options);
            const followUpContent = followUpResponse.message?.content || '';
            
            if (followUpContent) {
              responseContent += followUpContent;
              totalTokens += followUpResponse.usage?.total_tokens || 0;
              
              if (onContentChunk) {
                onContentChunk(followUpContent);
              }
              
              console.log(`✅ Follow-up response received: ${followUpContent.length} chars`);
            }
          } catch (followUpError) {
            console.error('❌ Follow-up request failed:', followUpError);
            if (onContentChunk) {
              onContentChunk('\n⚠️ Failed to process tool results, but tools were executed successfully.\n');
            }
          }
        }
      }

    } catch (error) {
      console.error('Standard chat execution failed:', error);
      responseContent = 'I apologize, but I encountered an error while processing your request. Please try again.';
    }

    // Create final Clara message
    const claraMessage: ClaraMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role: 'assistant',
      content: responseContent || 'I apologize, but I was unable to generate a response.',
      timestamp: new Date(),
      metadata: {
        model: `${config.provider}:${modelId}`,
        tokens: totalTokens,
        usage: finalUsage,
        timings: finalTimings,
        temperature: config.parameters.temperature,
        toolsUsed: toolResults.map(tc => tc.toolName),
        autonomousMode: false
      }
    };

    // Add artifacts if any were generated from tool calls
    if (toolResults.length > 0) {
      claraMessage.artifacts = this.parseToolResultsToArtifacts(toolResults);
    }

    return claraMessage;
  }

  /**
   * Check if we should disable streaming for this provider when tools are present
   */
  private shouldDisableStreamingForTools(tools: Tool[]): boolean {
    // If no tools are present, streaming is fine
    if (!tools || tools.length === 0) {
      return false;
    }

    // If no current provider, default to disabling streaming with tools
    if (!this.currentProvider) {
      return true;
    }

    // Check provider type and base URL to determine if it's OpenAI-like
    const providerType = this.currentProvider.type?.toLowerCase();
    const baseUrl = this.currentProvider.baseUrl?.toLowerCase() || '';

    // Disable streaming for OpenAI-like providers when tools are present
    // These providers stream tool call arguments incrementally which causes issues
    const isOpenAILike = 
      providerType === 'openai' ||
      providerType === 'openrouter' ||
      baseUrl.includes('openai.com') ||
      baseUrl.includes('openrouter.ai') ||
      baseUrl.includes('api.anthropic.com') ||
      baseUrl.includes('generativelanguage.googleapis.com'); // Google AI

    if (isOpenAILike) {
      console.log(`🔧 Detected OpenAI-like provider (${providerType}, ${baseUrl}), disabling streaming with tools`);
      return true;
    }

    // Keep streaming enabled for local providers like Ollama/llama.cpp
    // These providers handle tool calls correctly in streaming mode
    const isLocalProvider = 
      providerType === 'ollama' ||
      baseUrl.includes('localhost') ||
      baseUrl.includes('127.0.0.1') ||
      baseUrl.includes('0.0.0.0');

    if (isLocalProvider) {
      console.log(`🔧 Detected local provider (${providerType}, ${baseUrl}), keeping streaming enabled with tools`);
      return false;
    }

    // For unknown providers, default to disabling streaming with tools to be safe
    console.log(`🔧 Unknown provider type (${providerType}, ${baseUrl}), defaulting to disable streaming with tools`);
    return true;
  }

  /**
   * Process MCP tool results to handle all content types (text, images, files, etc.)
   */
  private processMCPToolResult(mcpResult: ClaraMCPToolResult, toolName: string): {
    result: any;
    artifacts: ClaraArtifact[];
    images: string[];
    toolMessage: ChatMessage;
  } {
    const artifacts: ClaraArtifact[] = [];
    const images: string[] = [];
    let textContent = '';
    let structuredResult: any = {};

    if (mcpResult.success && mcpResult.content) {
      console.log(`🔍 [MCP-PROCESS] Processing ${mcpResult.content.length} content items for ${toolName}`);
      
      for (let i = 0; i < mcpResult.content.length; i++) {
        const contentItem = mcpResult.content[i];
        console.log(`🔍 [MCP-PROCESS] Content item ${i}:`, contentItem);
        
        switch (contentItem.type) {
          case 'text':
            if (contentItem.text) {
              textContent += (textContent ? '\n\n' : '') + contentItem.text;
              structuredResult.text = contentItem.text;
            }
            break;
            
          case 'image':
            if (contentItem.data && contentItem.mimeType) {
              console.log(`🖼️ [MCP-PROCESS] Processing image: ${contentItem.mimeType}`);
              
              // Add to images array for AI model
              const imageData = contentItem.data.startsWith('data:') 
                ? contentItem.data 
                : `data:${contentItem.mimeType};base64,${contentItem.data}`;
              images.push(imageData);
              
              // Create artifact for the image using 'json' type since 'image' is not supported
              artifacts.push({
                id: `mcp-image-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: 'json',
                title: `${toolName} - Image Result`,
                content: JSON.stringify({
                  type: 'image',
                  mimeType: contentItem.mimeType,
                  data: imageData,
                  description: `Image generated by ${toolName}`
                }, null, 2),
                createdAt: new Date(),
                metadata: {
                  toolName,
                  mimeType: contentItem.mimeType,
                  source: 'mcp',
                  contentIndex: i,
                  originalType: 'image'
                }
              });
              
              // Add to structured result
              if (!structuredResult.images) structuredResult.images = [];
              structuredResult.images.push({
                mimeType: contentItem.mimeType,
                data: contentItem.data,
                url: imageData
              });
              
              // Add description to text content
              textContent += (textContent ? '\n\n' : '') + `📷 Image generated (${contentItem.mimeType})`;
            }
            break;
            
          case 'resource':
            if ((contentItem as any).resource) {
              console.log(`📄 [MCP-PROCESS] Processing resource:`, (contentItem as any).resource);
              
              // Create artifact for the resource
              artifacts.push({
                id: `mcp-resource-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: 'json',
                title: `${toolName} - Resource Result`,
                content: JSON.stringify((contentItem as any).resource, null, 2),
                createdAt: new Date(),
                metadata: {
                  toolName,
                  source: 'mcp',
                  contentIndex: i,
                  originalType: 'resource'
                }
              });
              
              // Add to structured result
              structuredResult.resource = (contentItem as any).resource;
              
              // Add description to text content
              textContent += (textContent ? '\n\n' : '') + `📄 Resource: ${JSON.stringify((contentItem as any).resource, null, 2)}`;
            }
            break;
            
          default:
            // Handle any additional content types that might be returned by MCP servers
            // even if they're not in the official type definition
            console.log(`🔍 [MCP-PROCESS] Processing additional content type: ${contentItem.type}`);
            
            if ((contentItem as any).data) {
              console.log(`📊 [MCP-PROCESS] Processing data content`);
              
              let contentData = (contentItem as any).data;
              if (typeof contentData === 'string') {
                try {
                  contentData = JSON.parse(contentData);
                } catch (e) {
                  console.warn('Failed to parse data content:', e);
                }
              }
              
              // Create artifact for the data
              artifacts.push({
                id: `mcp-data-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                type: 'json',
                title: `${toolName} - ${contentItem.type} Result`,
                content: JSON.stringify(contentData, null, 2),
                createdAt: new Date(),
                metadata: {
                  toolName,
                  source: 'mcp',
                  contentIndex: i,
                  originalType: contentItem.type
                }
              });
              
              // Add to structured result
              structuredResult.data = contentData;
              
              // Add description to text content
              textContent += (textContent ? '\n\n' : '') + `📊 ${contentItem.type}: ${JSON.stringify(contentData, null, 2)}`;
            } else if (contentItem.text || (contentItem as any).data) {
              // Handle any other content with text or data
              const content = contentItem.text || JSON.stringify((contentItem as any).data);
              textContent += (textContent ? '\n\n' : '') + `❓ ${contentItem.type}: ${content}`;
              structuredResult[`${contentItem.type}_${i}`] = contentItem;
            }
            break;
        }
      }
    }

    // Fallback if no content was processed
    if (!textContent && Object.keys(structuredResult).length === 0) {
      textContent = mcpResult.success ? 'MCP tool executed successfully' : (mcpResult.error || 'MCP tool execution failed');
      structuredResult = { message: textContent };
    }

    // Create the tool message for the conversation
    const toolMessage: ChatMessage = {
      role: 'tool',
      content: textContent,
      name: toolName
    };

    // Add images to the tool message if any
    if (images.length > 0) {
      toolMessage.images = images;
      console.log(`🖼️ [MCP-PROCESS] Added ${images.length} images to tool message`);
    }

    console.log(`✅ [MCP-PROCESS] Processed MCP result for ${toolName}:`, {
      textLength: textContent.length,
      artifactsCount: artifacts.length,
      imagesCount: images.length,
      structuredKeys: Object.keys(structuredResult)
    });

    return {
      result: Object.keys(structuredResult).length > 1 ? structuredResult : textContent,
      artifacts,
      images,
      toolMessage
    };
  }

  /**
   * Validate and sanitize OpenAI tools to prevent schema errors
   */
  private validateAndSanitizeOpenAITools(tools: any[]): any[] {
    const validatedTools: any[] = [];

    for (const tool of tools) {
      try {
        console.log(`🔍 [TOOL-VALIDATION] Validating tool: ${tool.function?.name}`);
        
        // Basic structure validation
        if (!tool.type || tool.type !== 'function') {
          console.warn(`⚠️ [TOOL-VALIDATION] Skipping tool with invalid type: ${tool.type}`);
          continue;
        }

        if (!tool.function) {
          console.warn(`⚠️ [TOOL-VALIDATION] Skipping tool without function property`);
          continue;
        }

        const func = tool.function;

        // Validate function name
        if (!func.name || typeof func.name !== 'string' || func.name.trim() === '') {
          console.warn(`⚠️ [TOOL-VALIDATION] Skipping tool with invalid name: ${func.name}`);
          continue;
        }

        // Validate description
        if (!func.description || typeof func.description !== 'string') {
          console.warn(`⚠️ [TOOL-VALIDATION] Tool ${func.name} missing description, adding default`);
          func.description = `Tool: ${func.name}`;
        }

        // Validate and fix parameters
        if (!func.parameters) {
          console.warn(`⚠️ [TOOL-VALIDATION] Tool ${func.name} missing parameters, adding default`);
          func.parameters = {
            type: 'object',
            properties: {},
            required: []
          };
        } else {
          // Sanitize parameters schema
          func.parameters = this.sanitizeParametersSchema(func.parameters, func.name);
        }

        // Validate the final tool structure
        const validation = this.validateToolStructure(tool);
        if (!validation.isValid) {
          console.error(`❌ [TOOL-VALIDATION] Tool ${func.name} failed final validation:`, validation.errors);
          
          // Create a minimal fallback tool
          const fallbackTool = {
            type: 'function',
            function: {
              name: func.name,
              description: `${func.description} (Schema validation failed)`,
              parameters: {
                type: 'object',
                properties: {},
                required: []
              }
            }
          };
          
          console.log(`🔧 [TOOL-VALIDATION] Created fallback tool for ${func.name}`);
          validatedTools.push(fallbackTool);
        } else {
          console.log(`✅ [TOOL-VALIDATION] Tool ${func.name} passed validation`);
          validatedTools.push(tool);
        }

      } catch (error) {
        console.error(`❌ [TOOL-VALIDATION] Error validating tool:`, error, tool);
        // Skip this tool entirely if we can't even process it
      }
    }

    console.log(`🔧 [TOOL-VALIDATION] Validated ${validatedTools.length}/${tools.length} tools`);
    return validatedTools;
  }

  /**
   * Sanitize parameters schema to ensure OpenAI compatibility
   */
  private sanitizeParametersSchema(schema: any, toolName: string): any {
    if (!schema || typeof schema !== 'object') {
      console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Invalid schema, using default`);
      return {
        type: 'object',
        properties: {},
        required: []
      };
    }

    // Deep clone to avoid modifying original
    const sanitized = JSON.parse(JSON.stringify(schema));

    // Ensure required top-level properties
    if (!sanitized.type) {
      sanitized.type = 'object';
    }
    if (sanitized.type !== 'object') {
      console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Top-level type must be 'object', fixing`);
      sanitized.type = 'object';
    }
    if (!sanitized.properties) {
      sanitized.properties = {};
    }
    if (!sanitized.required) {
      sanitized.required = [];
    }

    // Sanitize properties
    if (sanitized.properties && typeof sanitized.properties === 'object') {
      for (const [propName, propSchema] of Object.entries(sanitized.properties)) {
        if (propSchema && typeof propSchema === 'object') {
          const prop = propSchema as any;
          
          // Fix array properties missing 'items'
          if (prop.type === 'array' && !prop.items) {
            console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Adding missing 'items' for array property '${propName}'`);
            
            // Smart type detection for items
            let itemsType = 'string'; // Default
            if (propName.toLowerCase().includes('number') || propName.toLowerCase().includes('id')) {
              itemsType = 'number';
            } else if (propName.toLowerCase().includes('boolean') || propName.toLowerCase().includes('flag')) {
              itemsType = 'boolean';
            }
            
            prop.items = { type: itemsType };
          }

          // Ensure all properties have a type
          if (!prop.type) {
            console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Adding missing type for property '${propName}'`);
            prop.type = 'string'; // Default to string
          }

          // Validate array items
          if (prop.type === 'array' && prop.items) {
            if (typeof prop.items !== 'object') {
              console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Fixing invalid items for array property '${propName}'`);
              prop.items = { type: 'string' };
            } else if (!prop.items.type) {
              console.log(`🔧 [SCHEMA-SANITIZE] Tool ${toolName}: Adding missing type for items in array property '${propName}'`);
              prop.items.type = 'string';
            }
          }

          // Recursively sanitize nested objects
          if (prop.type === 'object' && prop.properties) {
            prop.properties = this.sanitizeParametersSchema(prop, `${toolName}.${propName}`).properties;
          }
        }
      }
    }

    // Validate required array
    if (sanitized.required && Array.isArray(sanitized.required)) {
      sanitized.required = sanitized.required.filter((reqProp: any) => {
        if (typeof reqProp !== 'string') {
          console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Removing non-string required property: ${reqProp}`);
          return false;
        }
        if (!sanitized.properties || !sanitized.properties[reqProp]) {
          console.warn(`⚠️ [SCHEMA-SANITIZE] Tool ${toolName}: Removing non-existent required property: ${reqProp}`);
          return false;
        }
        return true;
      });
    }

    return sanitized;
  }

  /**
   * Validate tool structure for OpenAI compatibility
   */
  private validateToolStructure(tool: any): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    try {
      // Check top-level structure
      if (!tool.type || tool.type !== 'function') {
        errors.push('Tool must have type "function"');
      }

      if (!tool.function) {
        errors.push('Tool must have a function property');
        return { isValid: false, errors };
      }

      const func = tool.function;

      // Check function properties
      if (!func.name || typeof func.name !== 'string' || func.name.trim() === '') {
        errors.push('Function must have a valid name');
      }

      if (!func.description || typeof func.description !== 'string') {
        errors.push('Function must have a description');
      }

      if (!func.parameters) {
        errors.push('Function must have parameters');
        return { isValid: false, errors };
      }

      // Validate parameters schema
      const paramErrors = this.validateParametersStructure(func.parameters);
      errors.push(...paramErrors);

    } catch (error) {
      errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate parameters structure recursively
   */
  private validateParametersStructure(schema: any, path: string = 'parameters'): string[] {
    const errors: string[] = [];

    if (!schema || typeof schema !== 'object') {
      errors.push(`${path}: Schema must be an object`);
      return errors;
    }

    // Check required top-level properties
    if (!schema.type) {
      errors.push(`${path}: Missing 'type' property`);
    } else if (schema.type !== 'object') {
      errors.push(`${path}: Top-level type must be 'object'`);
    }

    if (schema.properties !== undefined && typeof schema.properties !== 'object') {
      errors.push(`${path}: 'properties' must be an object`);
    }

    if (schema.required !== undefined && !Array.isArray(schema.required)) {
      errors.push(`${path}: 'required' must be an array`);
    }

    // Validate each property
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (propSchema && typeof propSchema === 'object') {
          const prop = propSchema as any;
          const propPath = `${path}.properties.${propName}`;

          // Check property type
          if (!prop.type) {
            errors.push(`${propPath}: Missing 'type' property`);
          } else {
            // Validate array properties
            if (prop.type === 'array') {
              if (!prop.items) {
                errors.push(`${propPath}: Array type must have 'items' property`);
              } else if (typeof prop.items !== 'object') {
                errors.push(`${propPath}: 'items' must be an object`);
              } else if (!prop.items.type) {
                errors.push(`${propPath}.items: Missing 'type' property`);
              }
            }

            // Validate object properties recursively
            if (prop.type === 'object' && prop.properties) {
              const nestedErrors = this.validateParametersStructure(prop, propPath);
              errors.push(...nestedErrors);
            }
          }
        }
      }
    }

    // Validate required array references existing properties
    if (schema.required && Array.isArray(schema.required) && schema.properties) {
      for (const reqProp of schema.required) {
        if (typeof reqProp !== 'string') {
          errors.push(`${path}: Required property names must be strings`);
        } else if (!schema.properties[reqProp]) {
          errors.push(`${path}: Required property '${reqProp}' does not exist in properties`);
        }
      }
    }

    return errors;
  }

  /**
   * Generate tools summary and execution plan using LLM
   */
  private async generateToolsSummaryAndPlan(
    userQuery: string,
    tools: Tool[],
    modelId: string,
    conversationHistory?: ClaraMessage[],
    onContentChunk?: (content: string) => void
  ): Promise<ToolsPlanResult> {
    if (!this.client) {
      throw new Error('No API client configured');
    }

    try {
      console.log(`🧠 Generating tools summary and plan for query: "${userQuery}"`);
      
      if (onContentChunk) {
        onContentChunk('🧠 **Analyzing available tools and conversation history...**\n\n');
      }

      // Group tools by category/server for better organization
      const toolsByCategory = this.groupToolsByCategory(tools);
      
      // Create a comprehensive tools description
      const toolsDescription = this.createToolsDescription(toolsByCategory);
      
      // Create conversation history summary for context
      const conversationContext = this.createConversationContextSummary(conversationHistory);
      
      // Create the planning prompt with conversation history
      const planningPrompt = `You are an AI assistant tasked with analyzing available tools and creating an execution plan for a user query, taking into account the conversation history.

USER QUERY: "${userQuery}"

CONVERSATION CONTEXT:
${conversationContext}

AVAILABLE TOOLS:
${toolsDescription}

Your task is to:
1. Create a CONCISE summary of the most relevant tools for this query
2. Create a STEP-BY-STEP execution plan that considers the conversation history
3. Identify which tools should be used in sequence
4. Estimate how many steps this will take
5. Consider what has already been done in the conversation to avoid repetition

IMPORTANT GUIDELINES:
- Focus ONLY on tools that are directly relevant to the user's query
- Consider the conversation history - don't repeat actions that were already successful
- If previous tool calls failed, plan alternative approaches
- For terminal/command tools (like iTerm MCP), plan to run a command AND then check the output
- For file operations, plan to read/write AND then verify the result
- For API calls, plan to make the call AND then process the response
- For Browser you can do all sorta things since you are using users browser
- Keep the summary concise but informative
- The plan should be logical and sequential
- Avoid repetitive tool calls - each step should build on the previous
- Reference previous conversation context when relevant

Respond in this EXACT format:

TOOLS_SUMMARY:
[Concise summary of the most relevant tools available for this task]

EXECUTION_PLAN:
Step 1: [First action with specific tool, considering conversation history]
Step 2: [Second action, often checking result of step 1]
Step 3: [Continue logically...]
[etc.]

RELEVANT_TOOLS:
[Comma-separated list of tool names that will likely be used]

ESTIMATED_STEPS:
[Number between 2-50]`;

      // ENHANCED: Include actual conversation history in planning messages
      const planningMessages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a helpful AI assistant that analyzes tools and creates execution plans. Be concise and practical. Consider conversation history to avoid repetition and build upon previous work.'
        }
      ];

      // Add conversation history if provided (similar to how autonomous agent does it)
      if (conversationHistory && conversationHistory.length > 0) {
        // Convert Clara messages to ChatMessage format for planning context
        // Take the last 10 messages to avoid overwhelming the planning model
        const recentHistory = conversationHistory.slice(-10);
        
        for (const historyMessage of recentHistory) {
          const chatMessage: ChatMessage = {
            role: historyMessage.role,
            content: historyMessage.content
          };

          // Add images if the message has image attachments
          if (historyMessage.attachments) {
            const imageAttachments = historyMessage.attachments.filter(att => att.type === 'image');
            if (imageAttachments.length > 0) {
              chatMessage.images = imageAttachments.map(att => att.base64 || att.url || '');
            }
          }

          planningMessages.push(chatMessage);
        }
        
        console.log(`📋 Including ${recentHistory.length} conversation messages in planning context`);
      }

      // Add the planning prompt as the final user message
      planningMessages.push({
        role: 'user',
        content: planningPrompt
      });

      console.log(`📋 Making planning request with ${tools.length} tools, ${planningMessages.length} messages, and full conversation context`);
      
      const planningResponse = await this.client.sendChat(modelId, planningMessages, {
        temperature: 0.6, // Lower temperature for more consistent planning
        max_tokens: 8000
      });

      const planningContent = planningResponse.message?.content || '';
      console.log(`📋 Planning response received: ${planningContent.length} chars`);

      // Parse the response
      const parsed = this.parsePlanningResponse(planningContent);
      
      if (onContentChunk) {
        onContentChunk(`✅ **Plan created with full conversation context:** ${parsed.estimatedSteps} steps identified\n\n`);
      }

      console.log(`✅ Generated plan with full conversation context:`, parsed);
      return parsed;

    } catch (error) {
      console.error('❌ Failed to generate tools summary and plan:', error);
      
      // Fallback to basic summary
      const fallbackSummary = `Available tools: ${tools.map(t => t.name).join(', ')}`;
      const fallbackPlan = `Step 1: Analyze the user's request\nStep 2: Use appropriate tools to fulfill the request\nStep 3: Provide results to the user`;
      
      return {
        summary: fallbackSummary,
        plan: fallbackPlan,
        relevantTools: tools.slice(0, 5).map(t => t.name), // First 5 tools as fallback
        estimatedSteps: 3
      };
    }
  }

  /**
   * Group tools by category/server for better organization
   */
  private groupToolsByCategory(tools: Tool[]): Record<string, Tool[]> {
    const categories: Record<string, Tool[]> = {};
    
    for (const tool of tools) {
      let category = 'General';
      
      // Categorize based on tool name patterns
      if (tool.name.startsWith('mcp_')) {
        // Extract server name from MCP tool name (e.g., mcp_github_create_issue -> github)
        const parts = tool.name.split('_');
        if (parts.length >= 3) {
          category = `MCP: ${parts[1].charAt(0).toUpperCase() + parts[1].slice(1)}`;
        } else {
          category = 'MCP: Unknown';
        }
      } else if (tool.name.includes('file') || tool.name.includes('read') || tool.name.includes('write')) {
        category = 'File Operations';
      } else if (tool.name.includes('terminal') || tool.name.includes('command') || tool.name.includes('shell')) {
        category = 'Terminal/Commands';
      } else if (tool.name.includes('web') || tool.name.includes('http') || tool.name.includes('api')) {
        category = 'Web/API';
      } else if (tool.name.includes('search') || tool.name.includes('find')) {
        category = 'Search/Discovery';
      }
      
      if (!categories[category]) {
        categories[category] = [];
      }
      categories[category].push(tool);
    }
    
    return categories;
  }

  /**
   * Create a comprehensive but concise tools description
   */
  private createToolsDescription(toolsByCategory: Record<string, Tool[]>): string {
    let description = '';
    
    for (const [category, tools] of Object.entries(toolsByCategory)) {
      description += `\n${category}:\n`;
      
      for (const tool of tools) {
        const requiredParams = tool.parameters.filter(p => p.required).map(p => p.name);
        const optionalParams = tool.parameters.filter(p => !p.required).map(p => p.name);
        
        description += `  • ${tool.name}: ${tool.description}\n`;
        if (requiredParams.length > 0) {
          description += `    Required: ${requiredParams.join(', ')}\n`;
        }
        if (optionalParams.length > 0 && optionalParams.length <= 3) { // Only show first 3 optional params
          description += `    Optional: ${optionalParams.slice(0, 3).join(', ')}\n`;
        }
      }
    }
    
    return description;
  }

  /**
   * Create conversation context summary for planning
   */
  private createConversationContextSummary(conversationHistory?: ClaraMessage[]): string {
    if (!conversationHistory || conversationHistory.length === 0) {
      return 'No previous conversation history.';
    }

    let contextSummary = '';
    let toolUsageHistory = '';
    let recentMessages = '';
    let userIntents = '';
    
    // Analyze tool usage patterns
    const toolsUsed = new Set<string>();
    const failedTools = new Set<string>();
    const successfulTools = new Set<string>();
    const userQueries: string[] = [];
    
    // Get recent messages (last 10 for context)
    const recentMsgs = conversationHistory.slice(-10);
    
    for (const message of conversationHistory) {
      // Collect user queries to understand intent progression
      if (message.role === 'user') {
        const query = message.content.length > 150 ? message.content.substring(0, 150) + '...' : message.content;
        userQueries.push(query);
      }
      
      // Track tool usage from metadata
      if (message.metadata?.toolsUsed && Array.isArray(message.metadata.toolsUsed)) {
        for (const tool of message.metadata.toolsUsed) {
          toolsUsed.add(tool);
          successfulTools.add(tool);
        }
      }
      
      // Track failed tools from error metadata
      if (message.metadata?.error && message.content.includes('tool')) {
        // Try to extract tool name from error context
        const toolMatch = message.content.match(/tool[:\s]+([a-zA-Z_]+)/i);
        if (toolMatch) {
          failedTools.add(toolMatch[1]);
        }
      }
    }
    
    // Create user intent progression summary
    if (userQueries.length > 0) {
      userIntents += `\nUser intent progression (${userQueries.length} queries):\n`;
      // Show last 3 user queries to understand the conversation flow
      const recentQueries = userQueries.slice(-3);
      recentQueries.forEach((query, index) => {
        const position = userQueries.length - recentQueries.length + index + 1;
        userIntents += `${position}. ${query}\n`;
      });
    }
    
    // Create tool usage summary
    if (toolsUsed.size > 0) {
      toolUsageHistory += `\nTool usage history:\n`;
      if (successfulTools.size > 0) {
        toolUsageHistory += `✅ Successfully used: ${Array.from(successfulTools).join(', ')}\n`;
      }
      if (failedTools.size > 0) {
        toolUsageHistory += `❌ Previously failed: ${Array.from(failedTools).join(', ')}\n`;
      }
    }
    
    // Create recent messages summary with more detail
    if (recentMsgs.length > 0) {
      recentMessages += `\nRecent conversation context (last ${recentMsgs.length} messages):\n`;
      for (let i = 0; i < recentMsgs.length; i++) {
        const msg = recentMsgs[i];
        const preview = msg.content.length > 200 ? msg.content.substring(0, 200) + '...' : msg.content;
        const timestamp = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
        recentMessages += `[${timestamp}] ${msg.role === 'user' ? 'User' : 'Assistant'}: ${preview}\n`;
        
        // Add tool usage info if available
        if (msg.metadata?.toolsUsed && msg.metadata.toolsUsed.length > 0) {
          recentMessages += `  └─ Tools used: ${msg.metadata.toolsUsed.join(', ')}\n`;
        }
        
        // Add error info if available
        if (msg.metadata?.error) {
          recentMessages += `  └─ ⚠️ Error occurred\n`;
        }
      }
    }
    
    // Combine all context with conversation statistics
    contextSummary = `Conversation has ${conversationHistory.length} total messages (${userQueries.length} user queries).`;
    
    if (userIntents) {
      contextSummary += userIntents;
    }
    
    if (toolUsageHistory) {
      contextSummary += toolUsageHistory;
    }
    
    if (recentMessages) {
      contextSummary += recentMessages;
    }
    
    if (!toolUsageHistory && !recentMessages && !userIntents) {
      contextSummary += '\nNo significant tool usage, user queries, or recent activity to consider.';
    }
    
    // Add planning guidance based on conversation analysis
    contextSummary += `\n\nPLANNING GUIDANCE:`;
    if (successfulTools.size > 0) {
      contextSummary += `\n- Consider reusing successful tools: ${Array.from(successfulTools).join(', ')}`;
    }
    if (failedTools.size > 0) {
      contextSummary += `\n- Avoid or find alternatives to failed tools: ${Array.from(failedTools).join(', ')}`;
    }
    if (userQueries.length > 1) {
      contextSummary += `\n- This is a multi-turn conversation - build upon previous context`;
    }
    
    return contextSummary;
  }

  /**
   * Parse the planning response from the LLM
   */
  private parsePlanningResponse(content: string): ToolsPlanResult {
    const lines = content.split('\n');
    let summary = '';
    let plan = '';
    let relevantTools: string[] = [];
    let estimatedSteps = 3; // Default
    
    let currentSection = '';
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('TOOLS_SUMMARY:')) {
        currentSection = 'summary';
        continue;
      } else if (trimmed.startsWith('EXECUTION_PLAN:')) {
        currentSection = 'plan';
        continue;
      } else if (trimmed.startsWith('RELEVANT_TOOLS:')) {
        currentSection = 'tools';
        continue;
      } else if (trimmed.startsWith('ESTIMATED_STEPS:')) {
        currentSection = 'steps';
        continue;
      }
      
      if (currentSection === 'summary' && trimmed) {
        summary += (summary ? '\n' : '') + trimmed;
      } else if (currentSection === 'plan' && trimmed) {
        plan += (plan ? '\n' : '') + trimmed;
      } else if (currentSection === 'tools' && trimmed) {
        relevantTools = trimmed.split(',').map(t => t.trim()).filter(t => t);
      } else if (currentSection === 'steps' && trimmed) {
        const match = trimmed.match(/(\d+)/);
        if (match) {
          estimatedSteps = Math.min(Math.max(parseInt(match[1]), 1), 10); // Clamp between 1-10
        }
      }
    }
    
    // Fallbacks if parsing failed
    if (!summary) {
      summary = 'Tools available for completing your request.';
    }
    if (!plan) {
      plan = 'Step 1: Analyze request\nStep 2: Execute appropriate tools\nStep 3: Provide results';
    }
    
    return {
      summary: summary.trim(),
      plan: plan.trim(),
      relevantTools,
      estimatedSteps
    };
  }

  /**
   * Verify task completion using structured analysis
   */
  private async verifyTaskCompletion(
    originalRequest: string,
    toolResults: any[],
    context: AgentExecutionContext,
    currentStep: number,
    modelId: string,
    onContentChunk?: (content: string) => void
  ): Promise<CompletionAnalysis> {
    console.log(`🔍 ====== VERIFY TASK COMPLETION METHOD ENTERED ======`);
    console.log(`🔍 Method Parameters:`);
    console.log(`  - originalRequest: "${originalRequest}"`);
    console.log(`  - toolResults length: ${toolResults?.length || 0}`);
    console.log(`  - context:`, {
      originalQuery: context?.originalQuery,
      currentStep: context?.currentStep,
      maxSteps: context?.maxSteps,
      progressLog: context?.progressLog?.length || 0,
      toolsSummary: context?.toolsSummary ? 'present' : 'missing',
      executionPlan: context?.executionPlan ? 'present' : 'missing'
    });
    console.log(`  - currentStep: ${currentStep}`);
    console.log(`  - modelId: "${modelId}"`);
    console.log(`  - onContentChunk: ${!!onContentChunk}`);
    
    if (!this.client) {
      console.error(`🔍 ❌ VERIFICATION FAILED: No API client configured`);
      throw new Error('No API client configured');
    }
    
    console.log(`🔍 ✅ API client is available`);

    try {
      console.log(`🔍 🚀 Starting verification process...`);
      console.log(`🔍 Starting completion verification for: "${originalRequest}"`);
      
      if (onContentChunk) {
        console.log(`🔍 📢 Sending verification start message to UI`);
        onContentChunk('\n**🔍 VERIFYING TASK COMPLETION...**\n\n');
      } else {
        console.log(`🔍 ⚠️ No onContentChunk callback available for UI updates`);
      }

      // Format evidence for verification WITH execution steps
      console.log(`🔍 📝 Formatting evidence for verification...`);
      const allExecutionSteps = this.getAllExecutionSteps();
      console.log(`🔍 📝 Retrieved ${allExecutionSteps.length} execution steps for verification`);
      
      const evidenceCollected = this.formatEvidenceForVerification(toolResults, context, allExecutionSteps);
      console.log(`🔍 📝 Evidence collected length: ${evidenceCollected?.length || 0} characters`);
      console.log(`🔍 📝 Evidence preview:`, evidenceCollected?.substring(0, 200) + '...');
      
      console.log(`🔍 📋 Creating verification prompt...`);
      const verificationPrompt = `You are Clara's task completion verifier. Analyze whether the user's request has been fully satisfied.

**ORIGINAL USER REQUEST:**
"${originalRequest}"

**CURRENT EXECUTION STATUS:**
- Step: ${currentStep + 1}
- Tools executed: ${toolResults.length}
- Successful tools: ${toolResults.filter(r => r.success).length}
- Failed tools: ${toolResults.filter(r => !r.success).length}

**EVIDENCE COLLECTED:**
${evidenceCollected}

**EXECUTION PLAN (if available):**
${context.executionPlan || 'No plan generated'}

**CRITICAL TASK:**
Provide a thorough analysis in JSON format. Be CRITICAL and THOROUGH - only mark as "complete" if you have concrete evidence ALL parts of the request are done.

**Response in this EXACT JSON format:**
{
  "originalRequest": "${originalRequest.replace(/"/g, '\\"')}",
  "completedComponents": [
    {
      "description": "What was completed",
      "status": "completed|verified|attempted", 
      "evidence": ["concrete evidence pieces"],
      "confidence": 95
    }
  ],
  "missingComponents": [
    {
      "description": "What's still missing or incomplete",
      "priority": "high|medium|low",
      "requiredTools": ["tool1", "tool2"],
      "estimatedEffort": 3,
      "blockedBy": ["dependency issues"]
    }
  ],
  "completionStatus": "complete|partial|incomplete",
  "confidenceScore": 85,
  "nextActions": [
    {
      "action": "Specific action needed",
      "toolsNeeded": ["tool_name"],
      "expectedOutput": "What this should produce",
      "dependencies": ["what needs to happen first"]
    }
  ],
  "evidenceSummary": {
    "filesCreated": ["list"],
    "dataRetrieved": ["list"], 
    "operationsPerformed": ["list"],
    "verificationResults": ["list"]
  }
}

**GUIDELINES:**
- Mark "complete" ONLY if you have solid evidence ALL parts are done
- Be specific about evidence that proves completion
- If anything is missing/uncertain, mark as "partial" or "incomplete"
- Prioritize missing components by user impact
- Provide actionable next steps with specific tools`;

      // Use structured output with proper JSON schema
      const verificationMessages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are a thorough task completion verifier. Analyze evidence and provide structured completion analysis. Be critical and only mark tasks as complete when you have concrete proof.'
        },
        {
          role: 'user',
          content: verificationPrompt
        }
      ];

      const verificationOptions = {
        temperature: 0.1, // Low temperature for consistent analysis
        max_tokens: 2000,
        response_format: {
          type: "json_object" as const
        }
      };

      console.log(`🔍 📡 Sending completion verification request...`);
      console.log(`🔍 📡 Model ID: ${modelId}`);
      console.log(`🔍 📡 Messages count: ${verificationMessages.length}`);
      console.log(`🔍 📡 Options:`, verificationOptions);
      console.log(`🔍 📡 Verification messages:`, verificationMessages.map(m => ({ role: m.role, contentLength: m.content?.length })));
      
      const verificationStartTime = Date.now();
      const response = await this.client.sendChat(modelId, verificationMessages, verificationOptions);
      const verificationEndTime = Date.now();
      const responseContent = response.message?.content || '{}';
      
      console.log(`🔍 📄 Verification API call completed in ${verificationEndTime - verificationStartTime}ms`);
      console.log(`🔍 📄 Response status: ${response ? 'success' : 'failed'}`);
      console.log(`🔍 📄 Response content length: ${responseContent?.length || 0} characters`);
      console.log(`🔍 📄 Raw verification response:`, responseContent);
      
      try {
        console.log(`🔍 🔧 Attempting to parse JSON response...`);
        const analysis: CompletionAnalysis = JSON.parse(responseContent);
        console.log(`🔍 ✅ JSON parsing successful`);
        
        console.log(`🔍 🔧 Parsed analysis object:`, {
          originalRequest: analysis.originalRequest?.substring(0, 50) + '...',
          completionStatus: analysis.completionStatus,
          confidenceScore: analysis.confidenceScore,
          completedComponents: analysis.completedComponents?.length || 0,
          missingComponents: analysis.missingComponents?.length || 0,
          nextActions: analysis.nextActions?.length || 0,
          evidenceSummary: analysis.evidenceSummary ? 'present' : 'missing'
        });
        
        // Validate the analysis structure
        console.log(`🔍 🔧 Validating analysis structure...`);
        if (!analysis.completionStatus || analysis.confidenceScore === undefined) {
          console.warn(`🔍 ⚠️ Invalid completion analysis structure, using fallback`);
          console.warn(`🔍 ⚠️ Missing: completionStatus=${!analysis.completionStatus}, confidenceScore=${analysis.confidenceScore === undefined}`);
          return this.createFallbackCompletionAnalysis(originalRequest, toolResults, 'partial');
        }
        
        console.log(`🔍 ✅ Analysis structure validation passed`);
        console.log(`🔍 ✅ Completion verification complete:`, {
          status: analysis.completionStatus,
          confidence: analysis.confidenceScore,
          completedComponents: analysis.completedComponents?.length || 0,
          missingComponents: analysis.missingComponents?.length || 0,
          nextActions: analysis.nextActions?.length || 0
        });
        
        if (onContentChunk) {
          onContentChunk(`✅ **Analysis Complete** - Status: ${analysis.completionStatus} (${analysis.confidenceScore}% confidence)\n\n`);
        }
        
        return analysis;
        
      } catch (parseError) {
        console.error(`🔍 ❌ Failed to parse completion analysis JSON:`, parseError);
        console.error(`🔍 ❌ Parse error type:`, parseError instanceof Error ? parseError.name : typeof parseError);
        console.error(`🔍 ❌ Parse error message:`, parseError instanceof Error ? parseError.message : String(parseError));
        console.log(`🔍 📄 Problematic response content (first 500 chars):`, responseContent?.substring(0, 500));
        console.log(`🔍 📄 Full problematic response:`, responseContent);
        
        // Fallback to basic analysis
        console.log(`🔍 🔄 Using fallback analysis due to parse error`);
        return this.createFallbackCompletionAnalysis(originalRequest, toolResults, 'partial');
      }
      
    } catch (error) {
      console.error(`🔍 ❌ Completion verification failed:`, error);
      console.error(`🔍 ❌ Error type:`, error instanceof Error ? error.name : typeof error);
      console.error(`🔍 ❌ Error message:`, error instanceof Error ? error.message : String(error));
      console.error(`🔍 ❌ Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
      
      // Return fallback analysis on error
      console.log(`🔍 🔄 Using fallback analysis due to general error`);
      return this.createFallbackCompletionAnalysis(originalRequest, toolResults, 'incomplete');
    }
  }

  /**
   * Format evidence for completion verification including execution steps
   */
  private formatEvidenceForVerification(toolResults: any[], context: AgentExecutionContext, executionSteps?: ExecutionStep[]): string {
    if (toolResults.length === 0) {
      return 'No tool results available for verification.';
    }

    let evidence = '';
    
    // Successful tool results
    const successfulResults = toolResults.filter(r => r.success);
    if (successfulResults.length > 0) {
      evidence += `**SUCCESSFUL OPERATIONS (${successfulResults.length}):**\n`;
      successfulResults.forEach((result, index) => {
        evidence += `${index + 1}. **${result.toolName}**: `;
        if (result.result && typeof result.result === 'string') {
          const preview = result.result.length > 200 ? result.result.substring(0, 200) + '...' : result.result;
          evidence += `${preview}\n`;
        } else if (result.result && typeof result.result === 'object') {
          evidence += `${JSON.stringify(result.result).substring(0, 200)}...\n`;
        } else {
          evidence += 'Executed successfully\n';
        }
      });
      evidence += '\n';
    }

    // Failed tool results
    const failedResults = toolResults.filter(r => !r.success);
    if (failedResults.length > 0) {
      evidence += `**FAILED OPERATIONS (${failedResults.length}):**\n`;
      failedResults.forEach((result, index) => {
        evidence += `${index + 1}. **${result.toolName}**: ${result.error || 'Unknown error'}\n`;
      });
      evidence += '\n';
    }

    // DETAILED EXECUTION HISTORY - Include ALL step-by-step progress
    if (executionSteps && executionSteps.length > 0) {
      evidence += `**DETAILED EXECUTION HISTORY (${executionSteps.length} steps):**\n`;
      executionSteps.forEach((step, index) => {
        // Ensure timestamp is a Date object
        const timestamp = step.timestamp instanceof Date ? step.timestamp : new Date(step.timestamp);
        evidence += `\n**Step ${step.stepNumber + 1}** (${timestamp.toLocaleTimeString()}):\n`;
        evidence += `Progress: ${step.progressSummary}\n`;
        
        if (step.assistantMessage.content) {
          const content = step.assistantMessage.content.substring(0, 500);
          evidence += `Content: ${content}${step.assistantMessage.content.length > 500 ? '...' : ''}\n`;
        }
        
        if (step.toolCalls && step.toolCalls.length > 0) {
          evidence += `Tools Used: ${step.toolCalls.map(tc => tc.function?.name || 'unknown').join(', ')}\n`;
        }
        
        // Tool results are no longer stored in steps to save space
        // Assistant messages already contain processed information from tool results
        
        if (step.verificationLoop) {
          evidence += `Verification Loop: ${step.verificationLoop}\n`;
        }
      });
      evidence += '\n';
    }

    // Execution context
    evidence += `**EXECUTION CONTEXT:**\n`;
    evidence += `- Current step: ${context.currentStep + 1}\n`;
    evidence += `- Total attempts: ${context.attempts.length}\n`;
    if (context.progressLog && context.progressLog.length > 0) {
      evidence += `- Progress log: ${context.progressLog.join(', ')}\n`;
    }

    return evidence;
  }

  /**
   * Create fallback completion analysis when structured analysis fails
   */
  private createFallbackCompletionAnalysis(
    originalRequest: string, 
    toolResults: any[], 
    status: 'complete' | 'partial' | 'incomplete'
  ): CompletionAnalysis {
    const successfulTools = toolResults.filter(r => r.success);
    const failedTools = toolResults.filter(r => !r.success);
    
    return {
      originalRequest,
      completedComponents: successfulTools.map(tool => ({
        description: `${tool.toolName} executed successfully`,
        status: 'completed' as const,
        evidence: [tool.result ? String(tool.result).substring(0, 100) : 'Tool executed'],
        confidence: 70
      })),
      missingComponents: status !== 'complete' ? [{
        description: 'Unable to verify complete task fulfillment',
        priority: 'high' as const,
        requiredTools: ['verification_needed'],
        estimatedEffort: 2,
        blockedBy: ['unclear_requirements']
      }] : [],
      completionStatus: status,
      confidenceScore: status === 'complete' ? 80 : (status === 'partial' ? 60 : 40),
      nextActions: status !== 'complete' ? [{
        action: 'Review task requirements and continue execution',
        toolsNeeded: ['analysis'],
        expectedOutput: 'Clarified next steps',
        dependencies: ['task_analysis']
      }] : [],
      evidenceSummary: {
        filesCreated: [],
        dataRetrieved: [],
        operationsPerformed: successfulTools.map(t => t.toolName),
        verificationResults: [`${successfulTools.length} successful, ${failedTools.length} failed`]
      }
    };
  }

  /**
   * Create comprehensive execution summary from all steps and tool results
   */
  private createExecutionSummary(executionSteps: ExecutionStep[], toolResults: any[]): string {
    if (executionSteps.length === 0) return '';

    let summary = `\n---\n\n## 📋 **Execution Summary**\n\n`;
    
    // Overall statistics
    const totalSteps = executionSteps.length;
    const totalToolCalls = toolResults.length;
    const successfulTools = toolResults.filter(r => r.success).length;
    const failedTools = toolResults.filter(r => !r.success).length;
    
    summary += `**Overall Progress:**\n`;
    summary += `✅ Completed ${totalSteps} execution steps\n`;
    summary += `🔧 Executed ${totalToolCalls} tools (${successfulTools} successful, ${failedTools} failed)\n`;
    summary += `⏱️ Duration: ${this.calculateExecutionDuration(executionSteps)}\n\n`;

    // Detailed step-by-step breakdown
    summary += `**Detailed Step-by-Step Progress:**\n\n`;
    
    executionSteps.forEach((step, index) => {
      const stepNumber = step.stepNumber + 1;
      // Ensure timestamp is a Date object
      const timestamp = step.timestamp instanceof Date ? step.timestamp : new Date(step.timestamp);
      const timeString = timestamp.toLocaleTimeString();
      
      summary += `**Step ${stepNumber}** (${timeString})${step.verificationLoop ? ` [Loop ${step.verificationLoop}]` : ''}:\n`;
      
      // Extract key progress indicators from content
      const progressLines = this.extractProgressLines(step.assistantMessage.content || '');
      if (progressLines.length > 0) {
        progressLines.forEach(line => {
          summary += `${line}\n`;
        });
      } else {
        // Fallback to progress summary
        summary += `${step.progressSummary}\n`;
      }
      
      // Add tool information if available
      if (step.toolCalls && step.toolCalls.length > 0) {
        const toolNames = step.toolCalls.map(tc => tc.function?.name || 'unknown').join(', ');
        summary += `🔧 Tools: ${toolNames}\n`;
      }
      
      // Tool results are no longer stored in steps to save space
      // Assistant messages already contain processed information from tool results
      
      summary += `\n`;
    });

    // Key accomplishments section
    const keyAccomplishments = this.extractKeyAccomplishments(executionSteps, toolResults);
    if (keyAccomplishments.length > 0) {
      summary += `**🎯 Key Accomplishments:**\n`;
      keyAccomplishments.forEach(accomplishment => {
        summary += `• ${accomplishment}\n`;
      });
      summary += `\n`;
    }

    // Final results section
    if (successfulTools > 0) {
      summary += `**📊 Final Results:**\n`;
      const resultsByTool = this.groupResultsByTool(toolResults.filter(r => r.success));
      Object.entries(resultsByTool).forEach(([toolName, results]) => {
        summary += `• **${toolName}**: ${results.length} successful execution${results.length > 1 ? 's' : ''}\n`;
      });
    }

    return summary;
  }

  /**
   * Extract progress lines from assistant content
   */
  private extractProgressLines(content: string): string[] {
    const lines = content.split('\n');
    return lines.filter(line => 
      line.includes('✅') || 
      line.includes('🔄') || 
      line.includes('📊') ||
      line.includes('🎯') ||
      line.includes('**Progress') ||
      line.includes('**Current State') ||
      line.includes('**Navigated') ||
      line.includes('**Found') ||
      line.includes('**Clicked') ||
      line.includes('**Captured') ||
      line.includes('**Extracted') ||
      line.includes('**Retrieved')
    ).map(line => line.trim()).filter(line => line.length > 0);
  }

  /**
   * Calculate execution duration
   */
  private calculateExecutionDuration(executionSteps: ExecutionStep[]): string {
    if (executionSteps.length === 0) return 'Unknown';
    
    // Ensure timestamps are Date objects
    const startTime = executionSteps[0].timestamp instanceof Date ? executionSteps[0].timestamp : new Date(executionSteps[0].timestamp);
    const endTime = executionSteps[executionSteps.length - 1].timestamp instanceof Date ? executionSteps[executionSteps.length - 1].timestamp : new Date(executionSteps[executionSteps.length - 1].timestamp);
    const durationMs = endTime.getTime() - startTime.getTime();
    const durationSeconds = Math.round(durationMs / 1000);
    
    if (durationSeconds < 60) {
      return `${durationSeconds} seconds`;
    } else {
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = durationSeconds % 60;
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Extract key accomplishments from execution steps
   */
  private extractKeyAccomplishments(executionSteps: ExecutionStep[], toolResults: any[]): string[] {
    const accomplishments: string[] = [];
    
    // Look for specific accomplishment patterns in content
    executionSteps.forEach(step => {
      const content = step.assistantMessage.content || '';
      const lines = content.split('\n');
      
      lines.forEach(line => {
        // Extract specific accomplishments
        if (line.includes('✅') && (
          line.includes('Navigated') ||
          line.includes('Found') ||
          line.includes('Extracted') ||
          line.includes('Retrieved') ||
          line.includes('Captured') ||
          line.includes('Clicked') ||
          line.includes('Processed')
        )) {
          const cleaned = line.replace(/✅\s*/, '').trim();
          if (cleaned && !accomplishments.includes(cleaned)) {
            accomplishments.push(cleaned);
          }
        }
      });
    });

    // Add tool-based accomplishments
    const successfulResults = toolResults.filter(r => r.success);
    const uniqueTools = [...new Set(successfulResults.map(r => r.toolName))];
    
    if (uniqueTools.includes('browser_action')) {
      const browserActions = successfulResults.filter(r => r.toolName === 'browser_action').length;
      accomplishments.push(`Performed ${browserActions} browser interaction${browserActions > 1 ? 's' : ''}`);
    }
    
    if (uniqueTools.includes('capture_page')) {
      const captures = successfulResults.filter(r => r.toolName === 'capture_page').length;
      accomplishments.push(`Captured ${captures} page structure${captures > 1 ? 's' : ''}`);
    }

    return accomplishments.slice(0, 10); // Limit to top 10 accomplishments
  }

  /**
   * Group tool results by tool name
   */
  private groupResultsByTool(toolResults: any[]): Record<string, any[]> {
    return toolResults.reduce((acc, result) => {
      const toolName = result.toolName || 'unknown';
      if (!acc[toolName]) {
        acc[toolName] = [];
      }
      acc[toolName].push(result);
      return acc;
    }, {} as Record<string, any[]>);
  }

  /**
   * Create user-friendly summary of tool results (hides technical details)
   */
  private createToolResultSummary(toolResults: any[]): string {
    if (toolResults.length === 0) {
      return '';
    }

    const successfulResults = toolResults.filter(r => r.success);
    const failedResults = toolResults.filter(r => !r.success);
    
    let summary = '';
    
    // Add successful results in user-friendly format
    if (successfulResults.length > 0) {
      for (const result of successfulResults) {
        if (result.result && typeof result.result === 'string') {
          // For string results, add them directly but limit length
          const content = result.result.length > 500 
            ? result.result.substring(0, 500) + '...' 
            : result.result;
          summary += content + '\n\n';
        } else if (result.result && typeof result.result === 'object') {
          // For object results, try to extract meaningful information
          if (result.toolName.includes('github')) {
            summary += this.formatGitHubResult(result) + '\n\n';
          } else if (result.toolName.includes('file') || result.toolName.includes('read')) {
            summary += this.formatFileResult(result) + '\n\n';
          } else if (result.toolName.includes('terminal') || result.toolName.includes('command')) {
            summary += this.formatTerminalResult(result) + '\n\n';
          } else {
            // Generic object formatting
            summary += this.formatGenericResult(result) + '\n\n';
          }
        }
      }
    }
    
    // Add failed results summary (without technical details)
    if (failedResults.length > 0) {
      summary += `\n⚠️ Some operations couldn't be completed (${failedResults.length} failed).`;
    }
    
    return summary.trim();
  }

  /**
   * Format GitHub-related tool results
   */
  private formatGitHubResult(result: any): string {
    const data = result.result;
    
    if (result.toolName.includes('create_issue')) {
      return `✅ Created GitHub issue: ${data.title || 'New Issue'} (#${data.number || 'N/A'})`;
    } else if (result.toolName.includes('list_issues')) {
      const issues = Array.isArray(data) ? data : [data];
      return `📋 Found ${issues.length} GitHub issues:\n${issues.slice(0, 5).map((issue: any) => 
        `• #${issue.number}: ${issue.title}`
      ).join('\n')}`;
    } else if (result.toolName.includes('create_pull_request')) {
      return `✅ Created pull request: ${data.title || 'New PR'} (#${data.number || 'N/A'})`;
    } else {
      return `✅ GitHub operation completed successfully`;
    }
  }

  /**
   * Format file operation results
   */
  private formatFileResult(result: any): string {
    const data = result.result;
    
    if (result.toolName.includes('read')) {
      const content = typeof data === 'string' ? data : JSON.stringify(data);
      const preview = content.length > 200 ? content.substring(0, 200) + '...' : content;
      return `📄 File content:\n${preview}`;
    } else if (result.toolName.includes('write') || result.toolName.includes('create')) {
      return `✅ File operation completed successfully`;
    } else {
      return `📁 File operation completed`;
    }
  }

  /**
   * Format terminal/command results
   */
  private formatTerminalResult(result: any): string {
    const data = result.result;
    
    if (typeof data === 'string') {
      // Clean up terminal output
      const cleanOutput = data
        .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI color codes
        .trim();
      
      const preview = cleanOutput.length > 300 ? cleanOutput.substring(0, 300) + '...' : cleanOutput;
      return `💻 Command output:\n\`\`\`\n${preview}\n\`\`\``;
    } else {
      return `💻 Command executed successfully`;
    }
  }

  /**
   * Format generic tool results
   */
  private formatGenericResult(result: any): string {
    const data = result.result;
    
    if (typeof data === 'object' && data !== null) {
      // Try to extract key information
      const keys = Object.keys(data);
      if (keys.includes('message')) {
        return `✅ ${data.message}`;
      } else if (keys.includes('status')) {
        return `✅ Status: ${data.status}`;
      } else if (keys.includes('result')) {
        return `✅ Result: ${data.result}`;
      } else {
        // Show first few key-value pairs
        const preview = keys.slice(0, 3).map(key => 
          `${key}: ${String(data[key]).substring(0, 50)}`
        ).join(', ');
        return `✅ Operation completed: ${preview}`;
      }
    } else {
      return `✅ Operation completed successfully`;
    }
  }

  /**
   * Select the appropriate model based on context and configuration
   */
  private selectAppropriateModel(
    config: ClaraAIConfig, 
    message: string, 
    attachments: ClaraFileAttachment[],
    conversationHistory?: ClaraMessage[]
  ): string {
    // If auto model selection is disabled, use the configured text model
    if (!config.features.autoModelSelection) {
      console.log('🔧 Auto model selection disabled, using text model:', config.models.text);
      return config.models.text || 'llama2';
    }

    console.log('🤖 Auto model selection enabled, analyzing context...');
    
    // Check for images in current attachments
    const hasCurrentImages = attachments.some(att => att.type === 'image');
    
    // Check for images in conversation history (last 10 messages for performance)
    const hasHistoryImages = conversationHistory ? 
      conversationHistory.slice(-10).some(msg => 
        msg.attachments && msg.attachments.some(att => att.type === 'image')
      ) : false;
    
    const hasImages = hasCurrentImages || hasHistoryImages;
    
    if (hasImages) {
      console.log(`📸 Images detected (current: ${hasCurrentImages}, history: ${hasHistoryImages})`);
    }
    
    // Check for code-related content
    const hasCodeFiles = attachments.some(att => att.type === 'code');
    const hasCodeKeywords = /\b(code|programming|function|class|variable|debug|compile|syntax|algorithm|script|development)\b/i.test(message);
    const hasCodeContext = hasCodeFiles || hasCodeKeywords;
    
    // Check for tools mode (non-streaming mode typically uses tools)
    const isToolsMode = config.features.enableTools && !config.features.enableStreaming;
    
    // Model selection priority:
    // 1. Vision model for images (especially important for streaming mode where vision is required)
    // 2. Code model for tools mode (better for complex reasoning and tool usage)
    // 3. Text model for streaming and general text
    
    if (hasImages && config.models.vision) {
      console.log('📸 Images detected, using vision model:', config.models.vision);
      return config.models.vision;
    }
    
    if (isToolsMode && config.models.code) {
      console.log('🛠️ Tools mode detected, using code model for better reasoning:', config.models.code);
      return config.models.code;
    }
    
    if (hasCodeContext && config.models.code && config.features.enableStreaming) {
      console.log('💻 Code context detected in streaming mode, using code model:', config.models.code);
      return config.models.code;
    }
    
    // Default to text model for streaming and general text
    console.log('📝 Using text model for general text/streaming:', config.models.text);
    return config.models.text || 'llama2';
  }

  /**
   * Preload/warm up a model with a minimal request to reduce waiting time
   * This is especially useful for local models that need to be loaded into memory
   */
  public async preloadModel(config: ClaraAIConfig, conversationHistory?: ClaraMessage[]): Promise<void> {
    if (!this.client || !config.models.text) {
      console.log('🔄 Skipping model preload: No client or model configured');
      return;
    }

    // Only preload for local providers (Ollama) to avoid unnecessary cloud API calls
    const isLocalProvider = config.provider === 'ollama' || 
                           this.currentProvider?.type === 'ollama' ||
                           this.currentProvider?.baseUrl?.includes('localhost') ||
                           this.currentProvider?.baseUrl?.includes('127.0.0.1');
    
    if (!isLocalProvider) {
      console.log('🔄 Skipping model preload: Cloud provider detected, no preloading needed');
      return;
    }

    try {
      // Determine model ID based on conversation context (including image history)
      let modelId = this.selectAppropriateModel(config, '', [], conversationHistory);
      
      // Extract model name from provider:model format if needed
      if (modelId.includes(':')) {
        const parts = modelId.split(':');
        modelId = parts.slice(1).join(':');
      }

      console.log(`🚀 Preloading model: ${modelId} for provider: ${config.provider}`);

      // Create a minimal message to warm up the model
      const warmupMessages = [
        {
          role: 'system' as const,
          content: 'You are Clara, a helpful AI assistant.'
        },
        {
          role: 'user' as const,
          content: 'Hi'
        }
      ];

      // Send minimal request with 1 token output to just load the model
      const warmupOptions = {
        temperature: 0.1,
        max_tokens: 1, // Minimal token output
        stream: false // No streaming for preload
      };

      console.log(`⚡ Sending warmup request for model: ${modelId}`);
      
      // Fire and forget - we don't care about the response, just want to trigger model loading
      this.client.sendChat(modelId, warmupMessages, warmupOptions).catch(error => {
        // Silently handle errors since this is just a warmup
        console.log(`🔄 Model warmup completed (may have failed, but that's okay): ${error.message}`);
      });

      console.log(`✅ Model preload initiated for: ${modelId}`);
      
    } catch (error) {
      // Silently handle preload errors since this is an optimization, not critical functionality
      console.log(`🔄 Model preload failed (non-critical): ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Record a successful tool execution to prevent false positive blacklisting
   */
  public recordToolSuccess(toolName: string, toolDescription: string, toolCallId?: string): void {
    const providerPrefix = this.currentProvider?.id || 'unknown';
    
    ToolSuccessRegistry.recordSuccess(
      toolName,
      toolDescription,
      providerPrefix,
      toolCallId
    );
    
    console.log(`✅ [CLARA-API] Recorded successful execution of ${toolName} for provider ${providerPrefix}`);
  }

  /**
   * Clear incorrectly blacklisted tools for the current provider
   * This is useful when tools were blacklisted due to system bugs rather than actual tool issues
   */
  public clearBlacklistedTools(): void {
    if (this.currentProvider?.id) {
      console.log(`🧹 Clearing blacklisted tools for provider: ${this.currentProvider.name} (${this.currentProvider.id})`);
      
      // Clear from the current client if available
      if (this.client) {
        const baseClient = this.client as any;
        
        // Try to access the problematic tools clearing methods
        if (baseClient.clearProblematicToolsForProvider) {
          baseClient.clearProblematicToolsForProvider(this.currentProvider.id);
          console.log(`✅ Cleared blacklisted tools for provider ${this.currentProvider.id}`);
        }
        
        if (baseClient.clearProblematicTools) {
          baseClient.clearProblematicTools();
          console.log(`✅ Cleared all globally blacklisted tools`);
        }
        
        // Add notification about the fix
        addInfoNotification(
          'Tools Reset',
          `Cleared incorrectly blacklisted tools for ${this.currentProvider.name}. Tools affected by the tool_call_id bug are now available again.`,
          8000
        );
      } else {
        console.warn('⚠️ No API client available to clear blacklisted tools');
      }
    } else {
      console.warn('⚠️ No current provider to clear blacklisted tools for');
    }
  }

  /**
   * Determine task type from user query for categorization
   */
  private determineTaskType(query: string): string {
    const lowerQuery = query.toLowerCase();
    
    if (lowerQuery.includes('linkedin') || lowerQuery.includes('commenter') || lowerQuery.includes('social')) {
      return 'social_media_extraction';
    } else if (lowerQuery.includes('github') || lowerQuery.includes('repo') || lowerQuery.includes('code')) {
      return 'code_analysis';
    } else if (lowerQuery.includes('file') || lowerQuery.includes('download') || lowerQuery.includes('upload')) {
      return 'file_operations';
    } else if (lowerQuery.includes('browse') || lowerQuery.includes('website') || lowerQuery.includes('web')) {
      return 'web_browsing';
    } else if (lowerQuery.includes('search') || lowerQuery.includes('find') || lowerQuery.includes('lookup')) {
      return 'information_search';
    } else if (lowerQuery.includes('create') || lowerQuery.includes('generate') || lowerQuery.includes('make')) {
      return 'content_creation';
    } else if (lowerQuery.includes('analyze') || lowerQuery.includes('review') || lowerQuery.includes('check')) {
      return 'data_analysis';
    } else {
      return 'general_task';
    }
  }
}

// Export singleton instance
export const claraApiService = new ClaraApiService(); 