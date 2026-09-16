FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PORT=3015 \
    HOST=0.0.0.0

EXPOSE 3015

USER nobody

CMD ["sh", "-c", "uvicorn app.main:app --host ${HOST} --port ${PORT} --ws websockets --log-level info"]