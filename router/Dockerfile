FROM eclipse-temurin:21-jre-noble

ENV TZ=Europe/Amsterdam PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pyosmium python3-shapely osmium-tool tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG GH_VERSION=11.1
WORKDIR /app
RUN curl -fsSL -o /app/graphhopper-web.jar \
      "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GH_VERSION}/graphhopper-web-${GH_VERSION}.jar"

COPY config.yml prepare_night.py supervisor.py /app/
VOLUME /data
EXPOSE 8989 8990
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python3", "/app/supervisor.py"]
