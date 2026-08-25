@echo off
set "ARGS=%*"
echo {"type":"session"}
echo {"type":"agent_start"}
echo {"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"private"}}
if not "%ARGS:z-ai/glm-5.2=%"=="%ARGS%" exit /b 1
echo {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"OK"}}
echo {"type":"turn_end"}
exit /b 0
