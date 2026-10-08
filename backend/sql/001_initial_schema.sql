CREATE TABLE junctions (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    mode VARCHAR(30) NOT NULL DEFAULT 'AUTOMATIC',
    current_phase VARCHAR(50) NOT NULL DEFAULT 'NORTH_SOUTH',
    controller_status VARCHAR(30) NOT NULL DEFAULT 'ONLINE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE junction_queues (
    junction_id VARCHAR(50) REFERENCES junctions(id),
    direction VARCHAR(20) NOT NULL,
    queue_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (junction_id, direction),
    CHECK (queue_count >= 0)
);

CREATE TABLE sensor_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(100) UNIQUE NOT NULL,
    junction_id VARCHAR(50) NOT NULL,
    direction VARCHAR(20) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    vehicle_id VARCHAR(100),
    vehicle_type VARCHAR(50),
    sequence_no INTEGER,
    sensor_timestamp TIMESTAMP,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(30) DEFAULT 'PROCESSED'
);

CREATE TABLE traffic_commands (
    id SERIAL PRIMARY KEY,
    command_id VARCHAR(100) UNIQUE NOT NULL,
    junction_id VARCHAR(50) NOT NULL,
    command VARCHAR(100) NOT NULL,
    direction VARCHAR(20),
    requested_state VARCHAR(20),
    status VARCHAR(30) DEFAULT 'PENDING',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    acknowledged_at TIMESTAMP
);

CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    junction_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    direction VARCHAR(20),
    previous_state VARCHAR(20),
    new_state VARCHAR(20),
    command_id VARCHAR(100),
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE controller_events (
    id SERIAL PRIMARY KEY,
    command_id VARCHAR(100),
    junction_id VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL,
    actual_state VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);