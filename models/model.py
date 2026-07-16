from __future__ import annotations

import torch
from torch import nn


class FloodRiskLSTM(nn.Module):
    """Two-layer LSTM for 30 daily observations and five input features."""

    def __init__(self, input_size: int = 5, hidden_size: int = 64) -> None:
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers=2, batch_first=True, dropout=0.15)
        self.head = nn.Sequential(nn.Linear(hidden_size, 32), nn.ReLU(), nn.Linear(32, 1), nn.Sigmoid())

    def forward(self, sequence: torch.Tensor) -> torch.Tensor:
        output, _ = self.lstm(sequence)
        return self.head(output[:, -1]).squeeze(-1)
