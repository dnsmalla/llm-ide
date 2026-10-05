export declare type Options = {
    /** doc */
    abortController?: AbortController;
    resume?: string;
    nested?: {
        innerOnly?: boolean;
    };
};
export declare type SDKMessage = SDKAssistantMessage | SDKAPIRetryMessage;
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    /** doc */
    interrupt(): Promise<void>;
    close(): void;
}
